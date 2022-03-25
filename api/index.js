import dotenv from "dotenv";
dotenv.config();
import {resolve} from "path";
import {randomBytes} from "crypto";

// express
import express from "express";
import {configure, renderFile} from "eta";
import minifyHTML from "express-minify-html-terser";
import compression from "compression";
import helmet from "helmet";
import permissionsPolicy from "permissions-policy";
import useragent from "express-useragent";

// helpers/utilities
import got from "got";
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
const {NODE_ENV, BOT_TOKEN, WEBHOOK_SERVER, BOTLOG_CHATID, IP_BLACKLIST} = process.env;
const IS_PROD = Boolean(NODE_ENV) && NODE_ENV == "production";
const IPS_BLACKLIST = (Boolean(IP_BLACKLIST) && IP_BLACKLIST.split(" ").filter(Boolean)) || [];

// Telegram Bot API
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const WEBHOOK_URL = `${WEBHOOK_SERVER.replace(/\/+$/, "")}/webhook/${BOT_TOKEN}`;
const telegram = got.extend({
    prefixUrl: TELEGRAM_API,
    retry: {
        limit: 0,
    },
    timeout: {
        request: 1000,
    },
});

// REST API rate limiter
const queue = new PQueue({concurrency: 3});

// Global nonce
const ranuid = randomBytes(9).toString("hex");

const app = express();
// const router = express.Router();
app.set("trust proxy", true);
app.use(express.urlencoded({extended: true}));
app.use(express.json());
app.use((req, res, next) => {
    res.locals.nonce = ranuid;
    res.locals.baseURL = getURL(req, false);
    res.locals.canonicalURL = getURL(req, true);
    next();
});
configure({
    async: true,
    cache: IS_PROD,
    tags: ["{{", "}}"],
    varName: "it",
});
app.engine("html", renderFile);
app.set("view engine", "html");
app.set("views", resolve("views"));
app.use(
    express.static(resolve("public"), {
        index: false,
        maxAge: "30 days",
        setHeaders: (res) => res.set("X-Timestamp", Date.now()),
    }),
    minifyHTML({
        override: true,
        exception_url: false,
        htmlMinifier: {
            removeComments: true,
            collapseWhitespace: true,
            collapseBooleanAttributes: true,
            removeAttributeQuotes: false,
            removeEmptyAttributes: true,
            minifyJS: true,
            minifyCSS: true,
        },
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
    useragent.express(),
    (req, res, next) => {
        const ip = req.ip;
        const ua = req.useragent;
        const uam = {
            browser: ua.browser,
            version: ua.version,
            os: ua.os,
            platform: ua.platform,
            source: ua.source,
        };
        delete req.useragent;
        if (ip == "127.0.0.1" || ip == "::1") {
            res.locals.info = {ip, ...uam};
        } else {
            // const {range, eu, ll, metro, area, ...geo} = geoip.lookup(ip);
            res.locals.info = {ip, ...geoip.lookup(ip), ...uam};
        }
        next();
    },
);

function getURL(req, canonical = false) {
    const url = (canonical ? `https://${req.headers.host}${req.originalUrl}` : `https://${req.headers.host}`)
        .replace("www.", "")
        .toLowerCase();
    return url.replace(/\/+$/, "").trim();
}

function setNoCache(res) {
    const date = new Date();
    date.setFullYear(date.getFullYear() - 1);
    res.set("Expires", date.toUTCString());
    res.set("Pragma", "no-cache");
    res.set("Cache-Control", "public, no-cache");
}

async function renderPage(req, res, template) {
    res.set("Content-Type", "text/html");
    res.set("Cache-Control", "public, max-age=2592000"); // 30 days
    return void res.render("index", {
        ...{
            nonce: res.locals.nonce,
            baseURL: res.locals.baseURL,
            canonicalURL: res.locals.canonicalURL,
        },
        ...template,
    });
}

async function NotAPI(req, res) {
    let data = {};
    let is_api = false;
    const {api} = req.params;
    const {en, de, id, q} = req.query;
    await delay.range(150, 500);
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
                const headers = {Authorization: `Bearer ${process.env.SPAMWATCH_API}`};
                const ban = await got("https://api.spamwat.ch/banlist/" + id, {headers}).json();
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

async function webhookInit() {
    if (IS_PROD) {
        try {
            await telegram("deleteWebhook?url=" + WEBHOOK_URL);
        } catch (_) {}
        try {
            await telegram("getUpdates?offset=-1");
        } catch (_) {}
        try {
            await telegram("setWebhook?url=" + WEBHOOK_URL);
        } catch (_) {}
    } else {
        const {result} = await telegram("getMe").json();
        console.log(result);
    }
}

async function sendMessage(text) {
    return await telegram.post("sendMessage", {
        json: {
            chat_id: BOTLOG_CHATID,
            text: text,
            parse_mode: "html",
            disable_web_page_preview: true,
            disable_notification: false,
            reply_markup: {
                inline_keyboard: [
                    [
                        {
                            text: "Vercel Deployment",
                            url: "https://vercel.com/notudope/notapi",
                        },
                    ],
                ],
            },
        },
    });
}

async function notify(res, data) {
    let info = "";
    const result = JSON.stringify(data, null, 2);
    Object.entries(res.locals.info).forEach((x) => {
        const [k, v] = x;
        info += `<b>${k[0].toUpperCase()}${k.slice(1)}:</b> <code>${v}</code>\n`;
    });
    try {
        await sendMessage(`<pre>${result}</pre>\n\n${info}`);
    } catch (_) {
        try {
            await sendMessage(`<pre>${err}</pre>\n\n${info}`);
        } catch (__) {}
    }
}

const ping = new Cron("0 0 * * * *", {maxRuns: Infinity, paused: true}, async () => {
    try {
        await got(WEBHOOK_SERVER, {
            retry: {
                limit: 0,
            },
            timeout: {
                request: 1000,
            },
        }); // 1 hours
    } catch (_) {}
});

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

app.get("/api/:api", async (req, res, next) => {
    if (IPS_BLACKLIST.includes(req.ip)) {
        return next();
    }
    if (req.params) {
        const {is_api, data} = await queueNotAPI(req, res);
        if (is_api) {
            ping.pause();
            res.set("Access-Control-Allow-Methods", "GET, POST");
            res.set("Access-Control-Allow-Headers", "content-type");
            res.set("Access-Control-Allow-Origin", "*");
            res.set("Access-Control-Allow-Credentials", "true");
            res.set("Content-Type", "application/json");
            setNoCache(res);
            res.status(200);
            await notify(res, data);
            ping.resume();
            return res.json({...data});
        }
    }
    return res.status(320).redirect("/");
});

app.all("*", async (req, res) => {
    const template = {
        page: {
            title: "404 - NotAPI",
            description: "Page not found",
            robots: "noindex",
        },
        title: "404",
        description: "Didn’t find anything here!",
    };
    res.status(404);
    await renderPage(req, res, template);
});

if (!IS_PROD) {
    const PORT = process.env.PORT || 8080;
    app.listen(PORT, async () => void console.log(`🚀 Server listening on http://127.0.0.1:${PORT}`));
}

(async () => {
    await webhookInit();
    if (IS_PROD) {
        ping.resume();
    }
})();

export default app;
