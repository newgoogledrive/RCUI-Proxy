// Temporary fix: rewrite any client JS that tries to redirect to :8080
const http = require('http');
const originalWrite = http.ServerResponse.prototype.write;
const originalEnd = http.ServerResponse.prototype.end;

http.ServerResponse.prototype.write = function (chunk, ...args) {
    if (chunk && typeof chunk === 'string') {
        chunk = chunk.replace(/:8080/g, ''); // remove the :8080
    } else if (Buffer.isBuffer(chunk)) {
        chunk = Buffer.from(chunk.toString().replace(/:8080/g, ''));
    }
    return originalWrite.call(this, chunk, ...args);
};

http.ServerResponse.prototype.end = function (chunk, ...args) {
    if (chunk && typeof chunk === 'string') {
        chunk = chunk.replace(/:8080/g, '');
    } else if (Buffer.isBuffer(chunk)) {
        chunk = Buffer.from(chunk.toString().replace(/:8080/g, ''));
    }
    return originalEnd.call(this, chunk, ...args);
};

const cluster = require('cluster');
if (cluster.isMaster) {
    require('dotenv-flow').config();
}

const exitHook = require('async-exit-hook');
const sticky = require('sticky-session-custom');
const RammerheadProxy = require('../classes/RammerheadProxy');
const addStaticDirToProxy = require('../util/addStaticDirToProxy');
const RammerheadSessionFileCache = require('../classes/RammerheadSessionFileCache');
const config = require('../config');
const setupRoutes = require('./setupRoutes');
const setupPipeline = require('./setupPipeline');
const RammerheadLogging = require('../classes/RammerheadLogging');
const getSessionId = require('../util/getSessionId');

const prefix = config.enableWorkers ? (cluster.isMaster ? '(master) ' : `(${cluster.worker.id}) `) : '';

const logger = new RammerheadLogging({
    logLevel: config.logLevel,
    generatePrefix: (level) => prefix + config.generatePrefix(level)
});

const PORT = process.env.PORT || 10000;

const proxyServer = new RammerheadProxy({
    logger,
    loggerGetIP: config.getIP,
    bindingAddress: config.bindingAddress,
    port: PORT,                 // force Render port
    crossDomainPort: null,      // disable second server
    dontListen: config.enableWorkers,
    ssl: config.ssl,
    getServerInfo: config.getServerInfo,
    disableLocalStorageSync: config.disableLocalStorageSync,
    jsCache: config.jsCache,
    disableHttp2: config.disableHttp2,
    
    // Force client URLs to use Render port
    getClientPort: () => PORT,  
});
// Override _rewriteServerInfo to remove port for Render
const originalRewrite = proxyServer._rewriteServerInfo.bind(proxyServer);
proxyServer._rewriteServerInfo = (req) => {
    const info = originalRewrite(req);
    // Remove :port from domain
    info.domain = `${info.protocol}//${info.hostname}`;
    return info;
};


if (config.publicDir) addStaticDirToProxy(proxyServer, config.publicDir);

const fileCacheOptions = { logger, ...config.fileCacheSessionConfig };
if (!cluster.isMaster) {
    fileCacheOptions.staleCleanupOptions = null;
}
const sessionStore = new RammerheadSessionFileCache(fileCacheOptions);
sessionStore.attachToProxy(proxyServer);

setupPipeline(proxyServer, sessionStore);
setupRoutes(proxyServer, sessionStore, logger);

// nicely close proxy server and save sessions to store before we exit
exitHook(() => {
    logger.info(`(server) Received exit signal, closing proxy server`);
    proxyServer.close();
    logger.info('(server) Closed proxy server');
});

if (!config.enableWorkers) {
    const formatUrl = (secure, hostname, port) => `${secure ? 'https' : 'http'}://${hostname}:`;
    logger.info(
        `(server) Rammerhead proxy is listening on ${formatUrl(config.ssl, config.bindingAddress, config.port)}`
    );
}

// spawn workers if multithreading is enabled //
if (config.enableWorkers) {
    /**
     * @type {import('sticky-session-custom/lib/sticky/master').MasterOptions}
     */
    const stickyOptions = {
        workers: config.workers,
        generatePrehashArray(req) {
            let sessionId = getSessionId(req.url); // /sessionid/url
            if (!sessionId) {
                // /editsession?id=sessionid
                const parsed = new URL(req.url, 'https://a.com');
                sessionId = parsed.searchParams.get('id') || parsed.searchParams.get('sessionId');
                if (!sessionId) {
                    // sessionId is in referer header
                    for (let i = 0; i < req.headers.length; i += 2) {
                        if (req.headers[i].toLowerCase() === 'referer') {
                            sessionId = getSessionId(req.headers[i + 1]);
                            break;
                        }
                    }
                    if (!sessionId) {
                        // if there is still none, it's likely a static asset, in which case,
                        // just delegate it to a worker
                        sessionId = ' ';
                    }
                }
            }
            return sessionId.split('').map((e) => e.charCodeAt());
        }
    };
    logger.info(JSON.stringify({ port: config.port, crossPort: config.crossDomainPort, master: cluster.isMaster }));
    const closeMasters = [sticky.listen(proxyServer.server1, config.port, config.bindingAddress, stickyOptions)];
    if (config.crossDomainPort) {
    console.warn('crossDomainPort is disabled for Render');
    // skip creating server2
}


    if (closeMasters[0]) {
        // master process //
        const formatUrl = (secure, hostname, port) => `${secure ? 'https' : 'http'}://${hostname}`;
        logger.info(
            `Rammerhead proxy load balancer is listening on ${formatUrl(
                config.ssl,
                config.bindingAddress,
                config.port
            )}`
        );

        // nicely close proxy server and save sessions to store before we exit
        exitHook(async (done) => {
            logger.info('Master received exit signal. Shutting down workers');
            for (const closeMaster of closeMasters) {
                await new Promise((resolve) => closeMaster(resolve));
            }
            logger.info('Closed all workers');
            done();
        });
    } else {
        logger.info(`Worker ${cluster.worker.id} is running`);
    }
}

// if you want to just extend the functionality of this proxy server, you can
// easily do so using this. mainly used for debugging
module.exports = proxyServer;
