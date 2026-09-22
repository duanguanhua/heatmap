const http = require('http');
const https = require('https');
const url = require('url');
const {chromium} = require('playwright');

// 安全提示：请保持监听 localhost，切勿改为 0.0.0.0 或公网地址。
// 本服务会按 URL 转发到任意目标主机（开放代理），暴露到公网可能被第三方滥用（SSRF、隐藏请求来源），
// 并产生由你承担的流量与法律风险。
const HOST = 'localhost';
const PORT = 5000;
const EAST_MONEY_HOME_URL = 'https://www.eastmoney.com';

// ============ 配置 ============
const CONFIG = {
    host: HOST,
    port: PORT,
    homeUrl: EAST_MONEY_HOME_URL,
    timeout: 15000,
    playwrightTimeout: 30000
};

const BASE_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': '*/*',
    'Connection': 'keep-alive'
};

// ============ 日志工具 ============
function timestamp() {
    const d = new Date();
    const p = (n, len = 2) => String(n).padStart(len, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
        `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

function log(tag, msg) {
    console.log(`[${timestamp()}] [${tag}] ${msg}`);
}

function logError(tag, msg) {
    console.error(`[${timestamp()}] [${tag}] ${msg}`);
}

// 安全解码 URL（含中文/特殊字符的 % 编码），无效序列原样返回
function decodeUrlSafe(s) {
    try {
        return decodeURIComponent(s);
    } catch {
        return s;
    }
}

// ============ Playwright 管理器（页池模式） ============
class PlaywrightManager {
    constructor(poolSize = 2) {
        this.poolSize = poolSize;
        this.browser = null;
        this.context = null;
        this.idlePages = [];      // 空闲页池
        this.waitQueue = [];      // 等待获取 page 的请求队列
        this.initPromise = null;  // 初始化锁，防止并发重复初始化
    }

    async init() {
        if (this.initPromise) return this.initPromise;
        this.initPromise = this._doInit();
        return this.initPromise;
    }

    async _doInit() {
        log('Playwright', '正在初始化...');
        this.browser = await chromium.launch({
            headless: true,
            channel: 'chrome',
            args: [
                '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
                '--disable-extensions', '--disable-images',
                '--blink-settings=imagesEnabled=false',
                '--disable-blink-features=AutomationControlled'
            ],
            ignoreDefaultArgs: ['--enable-automation']
        });

        this.context = await this.browser.newContext({
            userAgent: BASE_HEADERS['User-Agent'],
            viewport: {width: 1280, height: 720},
            extraHTTPHeaders: BASE_HEADERS
        });

        await this.context.addInitScript(
            `Object.defineProperty(navigator, 'webdriver', { get: () => undefined });`
        );

        for (let i = 0; i < this.poolSize; i++) {
            const page = await this.context.newPage();
            await page.goto(CONFIG.homeUrl, {timeout: 8000});
            this.idlePages.push(page);
        }
        log('Playwright', `初始化完成，页池大小: ${this.poolSize}`);
    }

    // 获取一个可用 page，没有则排队等待
    async _acquirePage() {
        await this.init();
        if (this.idlePages.length > 0) {
            return this.idlePages.shift();
        }
        return new Promise(resolve => this.waitQueue.push(resolve));
    }

    // 归还 page，优先分给排队中的请求
    _releasePage(page) {
        if (this.waitQueue.length > 0) {
            this.waitQueue.shift()(page);
        } else {
            this.idlePages.push(page);
        }
    }

    // page 异常时重建并替换
    async _rebuildPage(brokenPage) {
        try {
            await brokenPage.close().catch(() => {});
        } catch {}
        try {
            const page = await this.context.newPage();
            await page.goto(CONFIG.homeUrl, {timeout: 8000});
            this._releasePage(page);
        } catch (e) {
            logError('Playwright', `重建 page 失败: ${e.message}`);
        }
    }

    async request(url, body = null) {
        const page = await this._acquirePage();
        if (!page) throw new Error('Playwright 已关闭，无可用 page');
        const method = body ? 'POST' : 'GET';
        log('Playwright', `${method} ${decodeUrlSafe(url)}`);

        try {
            const result = await page.evaluate(async ([url, homeUrl, postBody]) => {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 30000);

                try {
                    const options = {
                        method: postBody ? 'POST' : 'GET',
                        credentials: 'include',
                        signal: controller.signal,
                        headers: {
                            'Referer': homeUrl + '/',
                            'Origin': homeUrl,
                            'Accept': 'application/json, text/plain, */*',
                            'X-Requested-With': 'XMLHttpRequest',
                            ...(postBody ? {'Content-Type': 'application/x-www-form-urlencoded'} : {})
                        },
                        ...(postBody ? {body: postBody} : {})
                    };

                    const response = await fetch(url, options);
                    clearTimeout(timeoutId);
                    const text = await response.text();

                    try {
                        return {type: 'json', data: JSON.parse(text)};
                    } catch {
                        return {type: 'text', data: text};
                    }
                } catch (err) {
                    clearTimeout(timeoutId);
                    return null;
                }
            }, [url, CONFIG.homeUrl, body]);

            if (!result) throw new Error('Playwright 请求返回空');

            this._releasePage(page);
            return {
                content: result.type === 'json' ? JSON.stringify(result.data) : result.data,
                contentType: 'application/json; charset=utf-8'
            };
        } catch (e) {
            // page 可能已损坏，重建后不归还原 page
            this._rebuildPage(page);
            throw e;
        }
    }

    async cleanup() {
        // 唤醒所有等待中的请求，避免悬挂
        while (this.waitQueue.length > 0) {
            this.waitQueue.shift()(null);
        }
        try {
            for (const page of this.idlePages) {
                await page.close().catch(() => {});
            }
            if (this.context) await this.context.close();
            if (this.browser) await this.browser.close();
        } catch {
        }

        this.idlePages = [];
        this.waitQueue = [];
        this.context = null;
        this.browser = null;
        this.initPromise = null;
    }
}

// ============ 工具函数 ============
function getReferer(targetHost, queryString) {
    if (targetHost === 'fundf10.eastmoney.com') {
        const codeMatch = queryString?.match(/code=(\d+)/);
        const fundCode = codeMatch?.[1];
        return fundCode
            ? `http://fundf10.eastmoney.com/${fundCode}.html`
            : 'http://fundf10.eastmoney.com/';
    }
    return targetHost.includes('eastmoney.com')
        ? 'https://www.eastmoney.com/'
        : `https://${targetHost}/`;
}

function parseCharset(contentType) {
    if (!contentType) return 'utf-8';
    const match = contentType.match(/charset=([^;]+)/i);
    return match?.[1] || 'utf-8';
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => resolve(Buffer.concat(chunks).toString()));
        req.on('error', reject);
    });
}

// ============ HTTP 代理请求 ============
function httpProxyRequest(targetHost, targetPath, queryString, method, body, reqHeaders) {
    return new Promise((resolve, reject) => {
        const targetUrl = `https://${targetHost}${targetPath}${queryString ? '?' + queryString : ''}`;
        log('HTTP', `${method} ${decodeUrlSafe(targetUrl)}`);

        const options = url.parse(targetUrl);
        options.method = method;
        options.headers = {
            ...BASE_HEADERS,
            'Referer': getReferer(targetHost, queryString)
        };

        if (method === 'POST') {
            options.headers['Content-Type'] = reqHeaders['content-type'] || 'application/x-www-form-urlencoded';
            if (body) options.headers['Content-Length'] = Buffer.byteLength(body);
        }

        const req = https.request(options, (res) => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => {
                const buffer = Buffer.concat(chunks);
                const contentType = res.headers['content-type'] || '';
                resolve({
                    content: buffer.toString(parseCharset(contentType)),
                    contentType
                });
            });
        });

        req.on('error', reject);
        req.setTimeout(CONFIG.timeout, () => {
            req.destroy();
            reject(new Error('Timeout'));
        });

        if (method === 'POST' && body) req.write(body);
        req.end();
    });
}

// ============ 请求处理器 ============
class RequestHandler {
    constructor(playwright) {
        this.playwright = playwright;
    }

    async handle(req, res) {
        const parsed = url.parse(req.url, true);
        const path = parsed.pathname;
        const queryString = parsed.query
            ? new URLSearchParams(parsed.query).toString()
            : '';

        // CORS
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

        if (req.method === 'OPTIONS') {
            res.end();
            return;
        }

        // 路由解析
        const route = this.parseRoute(path);
        if (!route) {
            this.sendError(res, 404, 'Not found');
            return;
        }

        const {usePlaywright, target} = route;
        if (!target) {
            this.sendError(res, 400, 'Invalid proxy target');
            return;
        }

        // 解析目标主机和路径
        const targetParts = target.split('/', 1);
        const targetHost = targetParts[0];
        const targetPath = target.length > targetHost.length + 1
            ? target.slice(targetHost.length)
            : '/';

        try {
            const result = await this.executeRequest(
                usePlaywright, targetHost, targetPath,
                queryString, req.method, req
            );

            res.statusCode = 200;
            res.setHeader('Content-Type',
                result.contentType
                    ? result.contentType + '; charset=utf-8'
                    : 'text/plain; charset=utf-8'
            );
            res.end(result.content);
        } catch (e) {
            this.sendError(res, 500, e.message);
        }
    }

    parseRoute(path) {
        if (path.startsWith('/proxy/playwright/')) {
            return {
                usePlaywright: true,
                target: path.slice('/proxy/playwright/'.length)
            };
        }
        if (path.startsWith('/proxy/')) {
            return {
                usePlaywright: false,
                target: path.slice('/proxy/'.length)
            };
        }
        return null;
    }

    async executeRequest(usePlaywright, targetHost, targetPath, queryString, method, req) {
        if (usePlaywright) {
            return await this.handlePlaywrightRequest(targetHost, targetPath, queryString, method, req);
        }
        return await this.handleHttpRequest(targetHost, targetPath, queryString, method, req);
    }

    async handlePlaywrightRequest(targetHost, targetPath, queryString, method, req) {
        const url = `https://${targetHost}${targetPath}${queryString ? '?' + queryString : ''}`;

        if (method === 'GET') {
            return await this.playwright.request(url);
        }

        if (method === 'POST') {
            const body = await readBody(req);
            return await this.playwright.request(url, body);
        }

        throw new Error('Method not allowed');
    }

    async handleHttpRequest(targetHost, targetPath, queryString, method, req) {
        if (method === 'GET') {
            return await httpProxyRequest(targetHost, targetPath, queryString, 'GET', null, req.headers);
        }

        if (method === 'POST') {
            const body = await readBody(req);
            return await httpProxyRequest(targetHost, targetPath, '', 'POST', body, req.headers);
        }

        throw new Error('Method not allowed');
    }

    sendError(res, statusCode, message) {
        res.statusCode = statusCode;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({error: message}));
    }
}

// ============ Main 函数 ============
async function main() {
    log('Main', '=================================');
    log('Main', '  代理服务器启动中...');
    log('Main', '=================================');

    const playwright = new PlaywrightManager();
    const handler = new RequestHandler(playwright);

    const server = http.createServer((req, res) => handler.handle(req, res));

    // 优雅退出
    const shutdown = async (signal) => {
        log('Main', `收到 ${signal} 信号，正在关闭...`);
        await playwright.cleanup();
        server.close(() => {
            log('Main', '服务器已关闭');
            process.exit(0);
        });
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    server.listen(CONFIG.port, CONFIG.host, () => {
        log('Main', '✅ 代理服务器运行中');
        log('Main', `   地址: http://${CONFIG.host}:${CONFIG.port}`);
        log('Main', `   Playwright 页池: 2（支持并发）`);
        log('Main', '📋 路由规则:');
        log('Main', '   /proxy/xxx            -> HTTP 轻量请求');
        log('Main', '   /proxy/playwright/xxx -> Playwright 浏览器请求');
        log('Main', '📝 示例:');
        log('Main', '   curl http://localhost:5000/proxy/fundf10.eastmoney.com/FundArchivesDatas.aspx?type=jjcc&code=513310');
        log('Main', '   curl http://localhost:5000/proxy/playwright/push2his.eastmoney.com/api/qt/stock/kline/get?secid=1.600519');
        log('Main', '⏹️  按 Ctrl+C 停止服务器');
    });
}

// ============ 启动入口 ============
if (require.main === module) {
    main().catch(err => {
        logError('Main', `启动失败: ${err.message}`);
        process.exit(1);
    });
}