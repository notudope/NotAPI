import * as dotenv from "@tinyhttp/dotenv";
dotenv.config();
import {App} from "@tinyhttp/app";
import * as bodyParser from "milliparsec";
import {logger} from "@tinyhttp/logger";
import sirv from "sirv";
import * as eta from "eta";
import {minify} from "html-minifier-terser";
import compression from "compression";
import helmet from "helmet";
import permissionsPolicy from "permissions-policy";
import useragent from "express-useragent";

// helpers/utilities
import {resolve} from "path";
import {randomBytes} from "crypto";
import {performance} from "perf_hooks";
import {Agent} from "https";
import got from "got";
import FormData from "form-data";
import pify from "pify";
import delay from "delay";
import PQueue from "p-queue";
import Cron from "croner";
import geoip from "geoip-lite";

// API dependency
import morse from "morse-decoder";
import romans from "romans";
import {Client as Genius} from "genius-lyrics";
const genius = new Genius(process.env.GENIUS_API);

// Environment
let {DEV_MODE, BOT_TOKEN, WEBHOOK_SERVER, BOTLOG_CHATID} = process.env;
const IS_PROD = Boolean(process.env.NODE_ENV) && process.env.NODE_ENV == "production";
const IPS_BLACKLIST = (Boolean(process.env.IP_BLACKLIST) && process.env.IP_BLACKLIST.split(" ").filter(Boolean)) || [];
const UAS_BLACKLIST = (Boolean(process.env.UA_BLACKLIST) && process.env.UA_BLACKLIST.split(" ").filter(Boolean)) || [];

// Telegram Bot API
let StartTime;
const telegram = `https://api.telegram.org/bot${BOT_TOKEN}`;
const webhook_url = `${WEBHOOK_SERVER.replace(/\/+$/, "")}/webhook/${BOT_TOKEN}`;

// got instances
const fetch = got.extend({
    agent: {
        https: new Agent({
            keepAlive: true,
            keepAliveMsecs: 10000,
        }),
    },
    headers: {"user-agent": undefined, "content-type": "application/json", connection: "keep-alive"},
    responseType: "json",
    resolveBodyOnly: true,
    decompress: true,
    retry: 1, // {limit: 1},
    timeout: 10000, // {request: 10000},
});

// REST API rate limiter
const queue = new PQueue({concurrency: 3});

// Global nonce
const ranuid = randomBytes(9).toString("hex");

const app = new App();
if (!IS_PROD || DEV_MODE) {
    app.use(logger());
}
app.use(useragent.express(), async (req, res, next) => {
    const ip = req.ip || (req.headers["x-forwarded-for"] || "").replace(/:\d+$/, "") || req.connection.remoteAddress;
    const ua = req.useragent;
    const uam = {
        browser: ua.browser,
        version: ua.version,
        os: ua.os,
        platform: ua.platform,
        source: ua.source,
    };
    delete req.useragent;
    if (ip == "127.0.0.1" || ip == "::1" || ip == "::ffff:127.0.0.1") {
        res.locals.u = {ip, ...uam};
    } else {
        const {range, eu, ll, metro, area, ...geo} = geoip.lookup(ip);
        res.locals.u = {ip, ...geo, ...uam};
    }
    res.locals.nonce = ranuid;
    res.locals.baseURL = getURL(req, false);
    res.locals.canonicalURL = getURL(req, true);
    next();
});

function getURL(req, canonical = false) {
    const url = (canonical ? `${req.headers.host}${req.originalUrl}` : `${req.headers.host}`)
        .split("/")
        .filter(Boolean)
        .join("/")
        .trim();
    return "https://" + url;
}

function setNoCache(res) {
    const date = new Date();
    date.setFullYear(date.getFullYear() - 1);
    res.set({
        Expires: date.toUTCString(),
        Pragma: "no-cache",
        "Cache-Control": "public, no-cache",
    });
}

async function renderPage(req, res, template) {
    res.set({
        "Content-Type": "text/html",
        "Cache-Control": "public, max-age=2592000", // 30 days
    });
    return void res.render(
        "index.html",
        {
            ...{
                nonce: res.locals.nonce,
                baseURL: res.locals.baseURL,
                canonicalURL: res.locals.canonicalURL,
            },
            ...template,
        },
        {
            renderOptions: {
                async: true,
                cache: IS_PROD,
                tags: ["{{", "}}"],
                varName: "it",
                plugins: [
                    {
                        processTemplate: (html) => {
                            const minified = minify(html, {
                                minifyCSS: true,
                                minifyJS: true,
                                removeComments: true,
                                collapseWhitespace: true,
                                collapseBooleanAttributes: true,
                                removeAttributeQuotes: true,
                                removeEmptyAttributes: true,
                                continueOnParseError: true,
                                useShortDoctype: true,
                            });
                            return IS_PROD ? minified : html;
                        },
                    },
                ],
            },
        },
    );
}

async function NotAPI(req, res) {
    let data = {};
    let is_api = false;
    const {api} = req.params;
    const {en, de, id, q} = req.query;
    await delay.range(150, 300);
    // morse code
    if (api == "morse") {
        if (en) {
            is_api = true;
            data["input"] = `${en}`;
            try {
                const result = await pify(morse.encode, {excludeMain: true})(en);
                data["result"] = `${result}`;
            } catch (err) {
                data["result"] = err.message;
            }
        }
        if (de) {
            is_api = true;
            data["input"] = `${de}`;
            try {
                const result = await pify(morse.decode, {excludeMain: true})(de);
                data["result"] = `${result}`;
            } catch (err) {
                data["result"] = err.message;
            }
        }
    }
    // romans numerals
    if (api == "romans") {
        if (en) {
            is_api = true;
            data["input"] = `${en}`;
            try {
                const result = await pify(romans.romanize, {excludeMain: true})(+`${en}`);
                data["result"] = `${result}`;
            } catch (err) {
                data["result"] = err.message;
            }
        }
        if (de) {
            is_api = true;
            data["input"] = `${de}`;
            try {
                const result = await pify(romans.deromanize, {excludeMain: true})(de);
                data["result"] = `${result}`;
            } catch (err) {
                data["result"] = err.message;
            }
        }
    }
    // spamwatch check banned user
    if (api == "spamwatch") {
        if (id) {
            is_api = true;
            try {
                const url = `https://api.spamwat.ch/banlist/${id}`;
                const headers = {Authorization: `Bearer ${process.env.SPAMWATCH_API}`};
                const ban = await fetch(url, {headers});
                ban.date = new Date(ban.date * 1000);
                data["error"] = "";
                data = {...data, ...ban};
            } catch (err) {
                data["error"] = err.message;
            }
        }
    }
    // genius lyrics search
    if (api == "lyrics") {
        if (q) {
            is_api = true;
            try {
                const searches = await genius.songs.search(q);
                const song = searches[0];
                const lyrics = await song.lyrics();
                data["error"] = "";
                data["title"] = `${song.title}`;
                data["artist"] = `${song.artist.name}`;
                data["url"] = `${song.url}`;
                data["lyrics"] = `${lyrics}`;
            } catch (err) {
                data["error"] = err.message;
            }
        }
    }
    return {is_api, data};
}

async function queueNotAPI(req, res) {
    return queue.add(() => NotAPI(req, res));
}

const ping = new Cron("0 0 */6 * * *", {maxRuns: Infinity, paused: true}, async () => {
    try {
        await fetch(WEBHOOK_SERVER); // 6 hours
    } catch (_) {}
});

async function webhookInit() {
    if (IS_PROD || DEV_MODE) {
        try {
            await fetch(`deleteWebhook?url=${webhook_url}`, {prefixUrl: telegram});
        } catch (_) {}
        try {
            const {result: up} = await fetch(`getUpdates?offset=-1`, {prefixUrl: telegram});
            if (up.length > 0) {
                await fetch(`getUpdates?offset=${up[up.length - 1].update_id}`, {prefixUrl: telegram});
            }
        } catch (_) {}
        try {
            await fetch(`setWebhook?url=${webhook_url}`, {prefixUrl: telegram});
        } catch (_) {}
    }
    if (!IS_PROD) {
        const {result} = await fetch(`getMe`, {prefixUrl: telegram});
        console.info(result);
    }
}

async function sendMessage(chat_id, text, options) {
    const default_json = {
        chat_id,
        text,
        parse_mode: "html",
        disable_web_page_preview: true,
    };
    const json = {...default_json, ...options};
    const {result} = await fetch.post("sendMessage", {
        prefixUrl: telegram,
        json,
    });
    return result;
}

async function editMessageText(chat_id, message_id, text, options) {
    const default_json = {
        chat_id,
        message_id,
        text,
        parse_mode: "html",
        disable_web_page_preview: true,
    };
    const json = {...default_json, ...options};
    const {result} = await fetch.post("editMessageText", {
        prefixUrl: telegram,
        json,
    });
    return result;
}

async function notify(res, api, data) {
    let user = "";
    let result = JSON.stringify(data, null, 2);
    for (const [key, val] of Object.entries(res.locals.u)) {
        user += `<b>${key.toUpperCase()}:</b> <code>${val}</code>\n`;
    }
    try {
        if (result.length < 4096) {
            await sendMessage(BOTLOG_CHATID, `<pre>${result}</pre>\n\n${user}`);
        } else {
            const plain = user.replace(new RegExp("<[^>]*>", "g"), "");
            const filename = `${api}_${+res.locals.u["ip"].split("").filter(parseInt).join("")}.txt`;
            const data = `${result}\n\n${plain}`;
            const form = new FormData();
            form.append("chat_id", BOTLOG_CHATID);
            form.append("document", Buffer.from(data), {filename});
            await fetch.post("sendDocument", {
                prefixUrl: telegram,
                headers: form.getHeaders(),
                body: form,
            });
        }
    } catch (_) {
        try {
            await sendMessage(BOTLOG_CHATID, `<pre>${_}</pre>\n\n${user}`);
        } catch (__) {}
    }
}

function getUptime(uptime) {
    let totals = uptime / 1000;
    const days = Math.floor(totals / 86400);
    totals %= 86400;
    const hours = Math.floor(totals / 3600);
    totals %= 3600;
    const minutes = Math.floor(totals / 60);
    const seconds = Math.floor(totals % 60);
    return `${days}d:${hours}h:${minutes}m:${seconds}s`;
}

app.post("/webhook/:id", bodyParser.json(), async (req, res, next) => {
    const ctx = req.body;
    const is_private = ctx.message.chat.type == "private";
    const is_bot = ctx.message.from.is_bot;
    const chat_id = ctx.message.chat.id;
    const msg_id = ctx.message.message_id;
    const text = ctx.message.text || "";
    // https://core.telegram.org/bots/api
    let msg = {};
    let skipping = false;
    const blacklist = [""];
    if (new Date().getTime() / 1000 - ctx.message.date < 5 * 60) {
        skipping = false;
    } else if (!is_private || is_bot) {
        skipping = true;
    } else if (blacklist.some((x) => text.toLowerCase().includes(x))) {
        skipping = true;
    }
    if (skipping) {
        return res.status(200).send(msg);
    }
    if (text.match(/ping/gi)) {
        const start = performance.now();
        const reply = await sendMessage(chat_id, "Ping !", {disable_notification: true, reply_to_message_id: msg_id});
        const end = performance.now();
        const ms = Number((end - start) / 1000).toFixed(2);
        const up = getUptime(Date.now() - StartTime);
        msg = await editMessageText(
            reply.chat.id,
            reply.message_id,
            `🏓 Pong !!\n<b>Speed</b> - <code>${ms}ms</code>\n<b>Uptime</b> - <code>${up}</code>`,
        );
    } else if (ctx.message) {
        const raw = JSON.stringify(ctx.message, null, 2);
        msg = await sendMessage(chat_id, `<pre>${raw}</pre>`, {
            disable_notification: true,
            reply_to_message_id: msg_id,
        });
    }
    res.status(200).send(msg);
});

app.get("/api/:api", async (req, res, next) => {
    if (UAS_BLACKLIST.some((x) => res.locals.u.source.toLowerCase().includes(x))) {
        return res.status(403).send("Bot not allowed.");
    }
    if (IPS_BLACKLIST.includes(req.ip)) {
        return next();
    }
    if (req.params.api) {
        const {is_api, data} = await queueNotAPI(req, res);
        if (is_api) {
            // ping.pause();
            res.set({
                "Access-Control-Allow-Methods": "GET, POST",
                "Access-Control-Allow-Headers": "content-type",
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Credentials": "true",
                "Content-Type": "application/json",
            });
            setNoCache(res);
            res.status(200);
            await notify(res, req.params.api, data);
            // ping.resume();
            return res.end(JSON.stringify({...data}, null, null));
        }
    }
    return res.status(320).redirect("/");
});

app.engine("html", eta.renderFile);
app.use(
    sirv(resolve("public"), {
        etag: false,
        maxAge: 2592000,
        immutable: true,
    }),
    compression(),
    helmet({
        contentSecurityPolicy: {
            useDefaults: false,
            directives: {
                defaultSrc: ["'self'"],
                scriptSrc: ["'self'", (req, res) => `'nonce-${res.locals.nonce}'`, "cdn.jsdelivr.net"],
                imgSrc: ["'self'"],
                styleSrc: ["'self'", (req, res) => `'nonce-${res.locals.nonce}'`],
                fontSrc: ["'self'"],
                objectSrc: ["'none'"],
                upgradeInsecureRequests: [],
            },
        },
        dnsPrefetchControl: {allow: true},
    }),
    permissionsPolicy({
        features: {
            accelerometer: [],
            camera: [],
            geolocation: [],
            gyroscope: [],
            magnetometer: [],
            microphone: [],
            payment: [],
            usb: [],
            interestCohort: [],
        },
    }),
);

app.get("/", async (req, res) => {
    const template = {
        page: {
            title: "NotAPI",
            description: "A simple multi-featured API",
            robots: "index,follow",
        },
        title: "NotAPI",
        description: `A simple multi-featured API by <a href="https://github.com/notudope" title="GitHub @notudope">@notudope</a><br>How to use <a href="https://github.com/notudope/NotAPI" title="GitHub NotAPI">→ read here...</a>`,
    };
    res.status(200);
    await renderPage(req, res, template);
});

app.all("*", async (req, res) => {
    const template = {
        page: {
            title: "404 - NotAPI",
            description: "Page not found",
            robots: "noindex",
        },
        title: "404",
        description: "Didn't find anything here!",
    };
    res.status(404);
    await renderPage(req, res, template);
});

if (!IS_PROD) {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, async () => console.log(`🚀 Server listening on http://127.0.0.1:${PORT}`));
}

(async () => {
    StartTime = Date.now();
    await webhookInit();
    if (IS_PROD) {
        ping.resume();
    }
})();

// export default async (req, res) => await app.handler(req, res);
export default app;
