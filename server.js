try { require('dotenv').config(); } catch (e) { console.log("Mode Production"); }

const { Mistral } = require('@mistralai/mistralai');
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const clientAi = new Mistral({ apiKey: process.env.MISTRAL_API_KEY });

const ADMIN_LOGIN_USER = process.env.ADMIN_LOGIN_USER || "admin";
const ADMIN_LOGIN_PASSWORD = process.env.ADMIN_LOGIN_PASSWORD || "france";

const DATA_DIR = path.join(__dirname, "data");
const STOCK_PATH = path.join(DATA_DIR, "stock.json");
const EVENTS_PATH = path.join(DATA_DIR, "events.jsonl");

function ensureDataDir() {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readStock() {
    ensureDataDir();
    if (!fs.existsSync(STOCK_PATH)) return [];
    try {
        const raw = JSON.parse(fs.readFileSync(STOCK_PATH, "utf8"));
        return Array.isArray(raw) ? raw : [];
    } catch {
        return [];
    }
}

function writeStock(arr) {
    ensureDataDir();
    fs.writeFileSync(STOCK_PATH, JSON.stringify(arr, null, 2), "utf8");
}

function appendEvent(obj) {
    ensureDataDir();
    const line = JSON.stringify({ ...obj, ts: obj.ts || new Date().toISOString() }) + "\n";
    fs.appendFileSync(EVENTS_PATH, line, "utf8");
}

function readEvents() {
    ensureDataDir();
    if (!fs.existsSync(EVENTS_PATH)) return [];
    const text = fs.readFileSync(EVENTS_PATH, "utf8");
    return text
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => {
            try {
                return JSON.parse(line);
            } catch {
                return null;
            }
        })
        .filter(Boolean);
}

function extractSuggestion(answer) {
    if (!answer || !answer.includes("[SUGGESTION]")) return "";
    const after = answer.split("[SUGGESTION]")[1] || "";
    const next = after.search(/\[[A-Z]+\]/);
    const block = (next === -1 ? after : after.substring(0, next)).trim();
    const firstLine = block.split(/\r?\n/).find((l) => l.trim()) || "";
    return firstLine.replace(/[\[\]]/g, "").trim().substring(0, 220);
}

function isTechnicalFailure(answer) {
    if (!answer) return true;
    return answer.includes("[ERREUR]");
}

function logActivity(clientName, message) {
    const logDir = path.join(__dirname, "logs");
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    const safeName = clientName ? clientName.replace(/[^a-z0-9]/gi, "_") : "GENERAL_PUBLIC";
    const logFile = path.join(logDir, `${safeName}_activity.txt`);
    const line = `[${new Date().toLocaleString()}] ${message}\n`;
    fs.appendFile(logFile, line, (err) => {
        if (err) console.error("Erreur log:", err);
    });
}

function adminKeyOk(req) {
    const expected = process.env.ADMIN_SECRET || "aficionado-demo";
    return req.headers["x-admin-key"] === expected;
}

function sendJson(res, status, obj) {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(obj));
}

function readJsonBody(req) {
    return new Promise((resolve, reject) => {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
            if (!body) return resolve({});
            try {
                resolve(JSON.parse(body));
            } catch (e) {
                reject(e);
            }
        });
        req.on("error", reject);
    });
}

function buildFeaturedHint() {
    const featured = readStock().filter((p) => p.featured).slice(0, 3);
    if (featured.length === 0) return "";
    const lines = featured.map((p) => {
        const note = (p.infoComplementaire || p.description || "").trim();
        const bits = [p.nom, p.origine, p.gout, note].filter(Boolean).join(" — ");
        return `- ${bits}`;
    });
    return `\n\n⭐ MISE EN AVANT STOCK (max 3) : si la demande du client est compatible avec l'un de ces cigares, propose EN PRIORITÉ celui qui correspond le mieux (un seul choix principal) :\n${lines.join("\n")}`;
}

function aggregateAnalytics(yearChart, monthStr, filterYearStr) {
    const yChart = Math.min(2040, Math.max(2000, parseInt(yearChart, 10) || new Date().getFullYear()));
    const yFilter = filterYearStr
        ? Math.min(2040, Math.max(2000, parseInt(filterYearStr, 10) || yChart))
        : yChart;
    const mp = monthStr === null || monthStr === undefined || monthStr === "" ? 0 : parseInt(monthStr, 10);
    const m = mp >= 1 && mp <= 12 ? mp : 0;
    const all = readEvents();

    const totals = {
        conseille: all.length,
        succes: all.filter((e) => e.success).length,
        echec: all.filter((e) => !e.success).length,
    };

    const byMonth = Array.from({ length: 12 }, (_, i) => ({ month: i + 1, count: 0 }));
    all.forEach((e) => {
        const d = new Date(e.ts);
        if (d.getFullYear() === yChart) byMonth[d.getMonth()].count++;
    });

    const inFilter = (e) => {
        const d = new Date(e.ts);
        if (d.getFullYear() !== yFilter) return false;
        if (m >= 1 && m <= 12) return d.getMonth() + 1 === m;
        return true;
    };

    const sub = all.filter(inFilter);

    const bySource = { texte: 0, mes_envies: 0, flash: 0, nos_cigares: 0 };
    sub.forEach((e) => {
        const s = e.source && bySource[e.source] !== undefined ? e.source : "texte";
        bySource[s]++;
    });

    const queryCounts = {};
    sub.forEach((e) => {
        const q = (e.query || "").trim().substring(0, 500) || "(vide)";
        queryCounts[q] = (queryCounts[q] || 0) + 1;
    });
    const topQueriesSorted = Object.entries(queryCounts)
        .map(([query, count]) => ({ query, count }))
        .sort((a, b) => b.count - a.count);

    const resultCounts = {};
    sub.forEach((e) => {
        if (!e.success) return;
        const r = (e.suggestion || "").trim() || "(aucune suggestion parsée)";
        resultCounts[r] = (resultCounts[r] || 0) + 1;
    });
    const byResult = Object.entries(resultCounts)
        .map(([suggestion, count]) => ({ suggestion, count }))
        .sort((a, b) => b.count - a.count);

    const mouchard = sub
        .filter((e) => e.query)
        .map((e) => ({
            ts: e.ts,
            query: (e.query || "").substring(0, 280),
            source: e.source || "texte",
        }))
        .sort((a, b) => new Date(b.ts) - new Date(a.ts));

    const mouchardErrors = sub
        .filter((e) => !e.success)
        .map((e) => ({
            ts: e.ts,
            query: (e.query || "").substring(0, 280),
            error: e.error || "Erreur",
        }))
        .sort((a, b) => new Date(b.ts) - new Date(a.ts));

    return {
        yearChart: yChart,
        yearFilter: yFilter,
        month: m,
        totals,
        byMonth,
        bySource,
        topQueriesSorted,
        byResult,
        mouchard,
        mouchardErrors,
    };
}

const server = http.createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, GET, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Admin-Key");

    if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
    }

    const pathname = (req.url || "").split("?")[0];

    if (req.method === "POST" && pathname === "/api/admin/login") {
        try {
            const body = await readJsonBody(req);
            const u = (body.username || "").trim();
            const p = body.password != null ? String(body.password) : "";
            if (u === ADMIN_LOGIN_USER && p === ADMIN_LOGIN_PASSWORD) {
                const key = process.env.ADMIN_SECRET || "aficionado-demo";
                sendJson(res, 200, { ok: true, key });
            } else {
                sendJson(res, 401, { ok: false, error: "Identifiants invalides" });
            }
        } catch {
            sendJson(res, 400, { ok: false, error: "Requête invalide" });
        }
        return;
    }

    if (req.method === "GET" && pathname === "/api/stock") {
        const list = readStock()
            .slice()
            .sort((a, b) => (a.nom || "").localeCompare(b.nom || "", "fr", { sensitivity: "base" }));
        sendJson(res, 200, { items: list });
        return;
    }

    if (req.method === "GET" && pathname === "/api/admin/analytics") {
        if (!adminKeyOk(req)) {
            sendJson(res, 401, { error: "Unauthorized" });
            return;
        }
        const q = new URL(req.url, `http://${req.headers.host}`).searchParams;
        const data = aggregateAnalytics(
            q.get("year") || String(new Date().getFullYear()),
            q.get("month"),
            q.get("filterYear")
        );
        sendJson(res, 200, data);
        return;
    }

    if (req.method === "GET" && pathname === "/api/admin/stock") {
        if (!adminKeyOk(req)) {
            sendJson(res, 401, { error: "Unauthorized" });
            return;
        }
        const list = readStock().sort((a, b) => (a.nom || "").localeCompare(b.nom || "", "fr", { sensitivity: "base" }));
        sendJson(res, 200, { items: list });
        return;
    }

    if (req.method === "POST" && pathname === "/api/admin/stock") {
        if (!adminKeyOk(req)) {
            sendJson(res, 401, { error: "Unauthorized" });
            return;
        }
        try {
            const body = await readJsonBody(req);
            const items = readStock();
            const nom = (body.nom || "").trim();
            if (!nom) {
                sendJson(res, 400, { error: "Nom requis" });
                return;
            }
            let featured = !!body.featured;
            const currentFeatured = items.filter((p) => p.featured).length;
            if (featured && currentFeatured >= 3) featured = false;
            const info = (body.infoComplementaire || "").trim();
            const item = {
                id: crypto.randomUUID(),
                nom,
                annee: (body.annee || "").trim(),
                origine: (body.origine || "").trim(),
                infoComplementaire: info,
                gout: (body.gout || "equilibre").toLowerCase(),
                description: info,
                featured,
            };
            items.push(item);
            writeStock(items);
            sendJson(res, 200, { item });
        } catch {
            sendJson(res, 400, { error: "JSON invalide" });
        }
        return;
    }

    if (req.method === "POST" && pathname === "/api/admin/stock/toggle-feature") {
        if (!adminKeyOk(req)) {
            sendJson(res, 401, { error: "Unauthorized" });
            return;
        }
        try {
            const body = await readJsonBody(req);
            const id = body.id;
            if (!id) {
                sendJson(res, 400, { error: "id requis" });
                return;
            }
            const items = readStock();
            const idx = items.findIndex((p) => p.id === id);
            if (idx === -1) {
                sendJson(res, 404, { error: "Introuvable" });
                return;
            }
            const was = items[idx].featured;
            if (!was) {
                const count = items.filter((p) => p.featured).length;
                if (count >= 3) {
                    sendJson(res, 400, { error: "Maximum 3 cigares mis en avant." });
                    return;
                }
                items[idx].featured = true;
            } else {
                items[idx].featured = false;
            }
            writeStock(items);
            sendJson(res, 200, { items });
        } catch {
            sendJson(res, 400, { error: "JSON invalide" });
        }
        return;
    }

    if (req.method === "DELETE" && pathname.startsWith("/api/admin/stock/")) {
        if (!adminKeyOk(req)) {
            sendJson(res, 401, { error: "Unauthorized" });
            return;
        }
        const id = decodeURIComponent(pathname.replace("/api/admin/stock/", ""));
        if (!id) {
            sendJson(res, 400, { error: "id requis" });
            return;
        }
        const items = readStock().filter((p) => p.id !== id);
        if (items.length === readStock().length) {
            sendJson(res, 404, { error: "Introuvable" });
            return;
        }
        writeStock(items);
        sendJson(res, 200, { ok: true });
        return;
    }

    if (req.method === "GET") {
        if (
            req.url.includes(".env") ||
            req.url.includes("server.js") ||
            req.url.includes("package") ||
            req.url.includes("/logs/") ||
            req.url.includes("/clients/") ||
            req.url.includes("/data/")
        ) {
            res.writeHead(403);
            res.end("Forbidden");
            return;
        }

        const urlParams = new URL(req.url, `http://${req.headers.host}`).searchParams;
        const clientName = urlParams.get("client");
        if (clientName) logActivity(clientName, "📲 SCAN QR CODE");
        else logActivity(null, "🌍 VISITE SITE PUBLIC");

        let filePath;
        if (pathname === "/" || pathname === "") filePath = "app.html";
        else if (pathname === "/admin" || pathname === "/admin/") filePath = "admin.html";
        else filePath = pathname.substring(1);
        const ext = path.extname(filePath);
        let contentType = "text/html";
        if (ext === ".png") contentType = "image/png";
        if (ext === ".jpg" || ext === ".jpeg") contentType = "image/jpeg";
        if (ext === ".js") contentType = "application/javascript";

        fs.readFile(path.join(__dirname, filePath), (err, data) => {
            if (err) {
                res.writeHead(404);
                res.end("404");
                return;
            }
            res.writeHead(200, { "Content-Type": contentType });
            res.end(data);
        });
        return;
    }

    if (req.method === "POST" && req.url === "/ask") {
        let body = "";
        req.on("data", (chunk) => {
            body += chunk;
        });
        req.on("end", async () => {
            let question = "";
            let image = null;
            let context = null;
            let client = null;
            let src = "texte";
            let lang = "fr";
            try {
                const parsed = JSON.parse(body);
                question = parsed.question || "";
                image = parsed.image;
                context = parsed.context;
                client = parsed.client;
                const source = parsed.source;
                src = ["texte", "mes_envies", "flash", "nos_cigares"].includes(source) ? source : "texte";
                const l = parsed.lang;
                if (l === "en" || l === "ru") lang = l;
            } catch {
                sendJson(res, 400, { answer: "[ERREUR] Requête invalide." });
                return;
            }

            try {
                if (question && question.length > 500) question = question.substring(0, 500);

                logActivity(client, `❓ QUESTION : "${question}"`);

                let systemInstruction = "";
                if (client) {
                    const clientFile = path.join(__dirname, "clients", `${client}.json`);
                    if (fs.existsSync(clientFile)) {
                        try {
                            const stock = JSON.parse(fs.readFileSync(clientFile, "utf8"));
                            const listeProduits = stock
                                .map((p) => `- ${p.nom} (${p.prix}€) : ${p.module}, ${p.terroir}. ${p.description}`)
                                .join("\n");
                            systemInstruction = `🛑 MODE B2B. CLIENT : "${client}". STOCK STRICT : \n${listeProduits}\nTu ne proposes QUE ça.`;
                        } catch (err) {
                            console.error("Erreur JSON");
                        }
                    }
                }
                if (!systemInstruction) {
                    systemInstruction = "🌍 MODE ENCYCLOPÉDIE MONDIALE.";
                    systemInstruction += buildFeaturedHint();
                }

                const langRules = {
                    fr: {
                        reply: "Rédige TOUT le contenu des sections en français.",
                        refuse: "Désolé, ma passion n'est que le cigare",
                        illisible:
                            "Je ne suis pas sur de bien lire la bague du cigare, écrivez le moi par sécurité.",
                    },
                    en: {
                        reply: "Write ALL section content in English (UK/US). Keep a refined, expert tone.",
                        refuse: "Sorry, my passion is solely the cigar",
                        illisible:
                            "I cannot read the cigar band clearly — please type the name for safety.",
                    },
                    ru: {
                        reply: "Пиши ВЕСЬ текст разделов на русском языке. Тон — сдержанный эксперт.",
                        refuse: "Извините, моя страсть — только сигара",
                        illisible: "Не могу разобрать бортик сигары — напишите название для надёжности.",
                    },
                };
                const L = langRules[lang] || langRules.fr;

                const finalPrompt = `Tu es "L'Aficionado".
                MISSION : Conseiller le cigare avec distinction, calme et raffinement.
                ${systemInstruction}

                LANGUE : ${L.reply}
                En cas de refus (sujet hors cigare, image non cigare, demande inacceptable), réponds EXACTEMENT et UNIQUEMENT par cette phrase, sans autre texte : "${L.refuse}"

                ⛔️ RÈGLES DE STYLE (LUXE) ⛔️
                1. TON : Distingué, sobre, expert. Pas de familiarité.
                2. TYPOGRAPHIE : N'utilise JAMAIS de gras (**). Le texte doit être fluide.
                3. FORMAT : Utilise les CROCHETS [ ] uniquement pour les titres. Va à la ligne après chaque titre.

                🚨 RÈGLE D'OR ABSOLUE (SÉCURITÉ) 🚨
                REFUSE IMMÉDIATEMENT (réponse = phrase de refus ci-dessus, sans crochets) SI :
                1. Le sujet n'est pas le cigare.
                2. L'image n'est pas un cigare.
                3. La demande est ABSURDE, DÉGOÛTANTE ou VIOLENTE.

                RÈGLES DE CONTENU :
                1. [AROMES] : Liste verticale avec tirets. Mots simples (Bois, Miel, Café). EMOJI à la fin de chaque ligne.
                2. [SUGGESTION] : Nom (Pays, Format). Pas de "mm".
                3. [DEMANDE] : Reformule la demande avec élégance.

                STRUCTURE DE RÉPONSE OBLIGATOIRE :

                [DEMANDE]
                (Reformulation élégante)

                [SUGGESTION]
                Nom du Cigare (Pays, Format)

                [EXPLICATION]
                (Texte vendeur, sobre et convaincant.)

                [AROMES]
                - Arôme 1 🌰
                - Arôme 2 ☕
                - Arôme 3 🪵

                [DUREE]
                [Temps moyen]

                [PUISSANCE]
                [Chiffre 1 à 5] - [Mot]
                (Exemple : "2 - Doux". JAMAIS DE /5)

                [MOMENT]
                [L'occasion idéale]

                [ACCORDS]
                - Accord 1 🥃
                - Accord 2 ☕

                [PRIX]
                [Prix estimé]

                [CONSEILS]
                (Le mot de l'expert.)

                IMPORTANT : Les balises entre crochets [DEMANDE], [SUGGESTION], etc. restent EXACTEMENT en majuscules comme ci-dessus ; seul le texte qui suit chaque balise est dans la langue demandée.`;

                let messages = [];
                let model = "";
                let temp = 0.2;

                if (image) {
                    model = "pixtral-12b-2409";
                    temp = 0.1;
                    const visionPrompt = `ANALYSE CETTE IMAGE EN 3 ÉTAPES STRICTES :
                    PORTE 1 (NATURE) : Si ce n'est pas un cigare -> STOP -> réponds uniquement : "${L.refuse}"
                    PORTE 2 (LISIBILITÉ) : Si illisible -> STOP -> réponds uniquement : "${L.illisible}"
                    PORTE 3 (ANALYSE) : Si OK -> Remplis le format [TAG] ; contenu dans la langue demandée.`;
                    messages = [
                        {
                            role: "user",
                            content: [
                                { type: "text", text: finalPrompt + "\n\n" + visionPrompt },
                                { type: "image_url", imageUrl: image },
                            ],
                        },
                    ];
                } else {
                    model = "mistral-small-latest";
                    messages = [{ role: "system", content: finalPrompt }];
                    const cleanContext = (context || []).map((msg) => ({ role: msg.role, content: msg.content }));
                    messages = messages.concat(cleanContext);
                    messages.push({ role: "user", content: question });
                }

                const chatResponse = await clientAi.chat.complete({ model, temperature: temp, messages });
                const answer = chatResponse.choices[0].message.content;

                const success = !isTechnicalFailure(answer);
                const suggestion = success ? extractSuggestion(answer) : "";
                appendEvent({
                    source: src,
                    query: image ? "[image]" : (question || "").substring(0, 2000),
                    success,
                    error: success ? null : answer.substring(0, 500),
                    suggestion,
                });

                sendJson(res, 200, { answer });
            } catch (e) {
                console.error("ERREUR :", e.message);
                appendEvent({
                    source: src,
                    query: (question || "").substring(0, 2000),
                    success: false,
                    error: e.message || "Erreur serveur",
                    suggestion: "",
                });
                sendJson(res, 500, { answer: "[ERREUR] Problème technique." });
            }
        });
        return;
    }

    if (req.method === "POST" && req.url === "/feedback") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
        return;
    }

    res.writeHead(404);
    res.end("404");
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
    console.log(`🚬 L'Aficionado est en ligne sur le port ${PORT} !`);
});
