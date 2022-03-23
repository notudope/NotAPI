import * as dotenv from "dotenv";
dotenv.config();
import {resolve} from "path";

// express
import express from "express";
import * as Eta from "eta";
import minifyHTML from "express-minify-html-terser";
import compression from "compression";
import helmet from "helmet";
import cors from "cors";
import permissionsPolicy from "permissions-policy";
import useragent from "express-useragent";
import {IpFilter} from "express-ipfilter";

// helpers/utilities
import got from "got";
import geoip from "geoip-lite";
import {v4 as uuidv4} from "uuid";
import pify from "pify";
import delay from "delay";
import PQueue from "p-queue";

// API dependency
import morse from "morse-decoder";
import romans from "romans";
import {Client as Genius} from "genius-lyrics";
const genius = new Genius(process.env.GENIUS_API);
const IS_PROD = process.env.NODE_ENV == "production";

// Telegram Bot API
const {BOT_TOKEN, BOTLOG_CHATID, WEBHOOK_SERVER} = process.env;
const TELEGRAM_API = "https://api.telegram.org/bot" + BOT_TOKEN;
const WEBHOOK_URI = "/webhook/" + BOT_TOKEN;
const WEBHOOK_URL = WEBHOOK_SERVER.endsWith("/") ? WEBHOOK_SERVER.slice(0, -1) : WEBHOOK_SERVER + WEBHOOK_URI;
const telegram = got.extend({prefixUrl: TELEGRAM_API});

// Blacklisted IPs
const IP_BLACKLIST = Boolean(process.env.IP_BLACKLIST) ? process.env.IP_BLACKLIST.split(" ").filter(Boolean) : [];

// REST API rate limiter
const queue = new PQueue({concurrency: 3});
// Global nonce
const nouidv4 = uuidv4();

const app = express();
app.set("trust proxy", true);
app.use(express.urlencoded({extended: true}));
app.use(express.json());
app.use(function (req, res, next) {
    res.locals.nonce = nouidv4.replace(/-/g, "");
    res.locals.baseURL = getURL(req, false);
    res.locals.canonicalURL = getURL(req, true);
    next();
});
Eta.configure({
    cache: false,
    tags: ["{{", "}}"],
    varName: "it",
});
app.engine("html", Eta.renderFile);
app.set("view engine", "html");
app.set("views", resolve("views"));
app.use(express.static(resolve("public"), {index: false, maxAge: "30 days"}));
app.use(
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
);
app.use(compression());
app.use(
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
);
app.use(
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
app.use(useragent.express(), function (req, res, next) {
    let ip = (req.headers["x-forwarded-for"] || "").replace(/:\d+$/, "") || req.connection.remoteAddress;
    if (ip.includes("::ffff:")) {
        ip = ip.split(":").reverse()[0];
    }
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
});

function getURL(req, canonical = false) {
    const url = (canonical ? `https://${req.headers.host}${req.originalUrl}` : `https://${req.headers.host}`)
        .replace("www.", "")
        .toLowerCase();
    return (url.endsWith("/") ? url.slice(0, -1) : url).trim();
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
    return res.render("index", {
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
    await delay(150);
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
                const resp = await got("https://api.spamwat.ch/banlist/" + id, {headers}).json();
                resp.date = new Date(resp.date * 1000);
                const ban = {...resp};
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
        await telegram("deleteWebhook?url=" + WEBHOOK_URL);
        await telegram("getUpdates?offset=-1");
        await telegram("setWebhook?url=" + WEBHOOK_URL);
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
    } catch (err) {
        try {
            await sendMessage(`<pre>${err}</pre>\n\n${info}`);
        } catch (pass) {
            // pass
        }
    }
}

app.get("/", async function (req, res) {
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
    return await renderPage(req, res, template);
});

app.get("/api/:api", IpFilter(IP_BLACKLIST, {mode: "deny"}), cors(), async function (req, res) {
    if (req.params) {
        const {is_api, data} = await queueNotAPI(req, res);
        if (is_api) {
            res.set("Content-Type", "application/json");
            setNoCache(res);
            res.status(200);
            await notify(res, data);
            return res.json({...data});
        }
    }
    return res.redirect(302, "/");
});

app.all("*", async function (req, res) {
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
    return await renderPage(req, res, template);
});

if (!IS_PROD) {
    const PORT = process.env.PORT || 8080;
    app.listen(PORT, async () => console.log(`🚀 Server listening on http://127.0.0.1:${PORT}`));
}

(async () => {
    await webhookInit();
})();

export default app;
