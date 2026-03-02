// CORRECTION : Try/catch pour éviter le crash dotenv sur Render
try { require('dotenv').config(); } catch (e) { console.log("Mode Production"); }

const { Mistral } = require('@mistralai/mistralai');
const http = require("http");
const fs = require("fs");
const path = require("path");

const clientAi = new Mistral({apiKey: process.env.MISTRAL_API_KEY});

// --- LOGS ---
function logActivity(clientName, message) {
    const logDir = path.join(__dirname, 'logs');
    if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
    }

    const safeName = clientName ? clientName.replace(/[^a-z0-9]/gi, '_') : 'GENERAL_PUBLIC'; 
    const logFile = path.join(logDir, `${safeName}_activity.txt`);
    const line = `[${new Date().toLocaleString()}] ${message}\n`;
    
    fs.appendFile(logFile, line, (err) => { 
        if (err) console.error("Erreur log:", err); 
    });
}

const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    if (req.method === "GET") {
        if (req.url.includes(".env") || req.url.includes("server.js") || req.url.includes("package") || req.url.includes("/logs/") || req.url.includes("/clients/")) {
            res.writeHead(403); res.end("Forbidden"); return;
        }
        const urlParams = new URL(req.url, `http://${req.headers.host}`).searchParams;
        const clientName = urlParams.get('client');
        if (clientName) { logActivity(clientName, "📲 SCAN QR CODE"); } else { logActivity(null, "🌍 VISITE SITE PUBLIC"); }

        let filePath = req.url.split('?')[0] === "/" ? "app.html" : req.url.split('?')[0].substring(1);
        const ext = path.extname(filePath);
        let contentType = "text/html";
        if (ext === ".png") contentType = "image/png"; 
        if (ext === ".jpg" || ext === ".jpeg") contentType = "image/jpeg";
        if (ext === ".js") contentType = "application/javascript";

        fs.readFile(path.join(__dirname, filePath), (err, data) => {
            if (err) { res.writeHead(404); res.end("404"); return; }
            res.writeHead(200, { "Content-Type": contentType });
            res.end(data);
        });

    } else if (req.method === "POST" && req.url === "/ask") {
        let body = "";
        req.on("data", chunk => { body += chunk; });
        req.on("end", async () => {
            try {
                let { question, image, context, client } = JSON.parse(body);
                if (question && question.length > 500) question = question.substring(0, 500);
                
                console.log(`🗣️ DEMANDE (${client || "Public"}) :`, question);
                logActivity(client, `❓ QUESTION : "${question}"`);

                let systemInstruction = "";
                if (client) {
                    const clientFile = path.join(__dirname, 'clients', `${client}.json`);
                    if (fs.existsSync(clientFile)) {
                        try {
                            const stock = JSON.parse(fs.readFileSync(clientFile, 'utf8'));
                            let listeProduits = stock.map(p => `- ${p.nom} (${p.prix}€) : ${p.module}, ${p.terroir}. ${p.description}`).join("\n");
                            systemInstruction = `🛑 MODE B2B. CLIENT : "${client}". STOCK STRICT : \n${listeProduits}\nTu ne proposes QUE ça.`;
                        } catch (err) { console.error("Erreur JSON"); }
                    }
                } 
                if (!systemInstruction) systemInstruction = "🌍 MODE ENCYCLOPÉDIE MONDIALE.";

                const finalPrompt = `Tu es "L'Aficionado".
                MISSION : Conseiller le cigare avec distinction, calme et raffinement.
                ${systemInstruction}

                ⛔️ RÈGLES DE STYLE (LUXE) ⛔️
                1. TON : Distingué, sobre, expert. Pas de familiarité.
                2. TYPOGRAPHIE : N'utilise JAMAIS de gras (**). Le texte doit être fluide.
                3. FORMAT : Utilise les CROCHETS [ ] uniquement pour les titres. Va à la ligne après chaque titre.

                🚨 RÈGLE D'OR ABSOLUE (SÉCURITÉ) 🚨
                REFUSE IMMÉDIATEMENT (Réponse : "Désolé, ma passion n'est que le cigare") SI :
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

                Langue: Français`;

                let messages = [];
                let model = "";
                let temp = 0.2; // Température basse pour éviter les délires
                
                if (image) {
                    model = "pixtral-12b-2409";
                    temp = 0.1; 
                    const visionPrompt = `ANALYSE CETTE IMAGE EN 3 ÉTAPES STRICTES :
                    PORTE 1 (NATURE) : Si ce n'est pas un cigare -> STOP -> "Désolé, ma passion n'est que le cigare".
                    PORTE 2 (LISIBILITÉ) : Si illisible -> STOP -> "Je ne suis pas sur de bien lire la bague du cigare, écrivez le moi par sécurité."
                    PORTE 3 (ANALYSE) : Si OK -> Remplis le format [TAG] sans crochets inutiles.`;
                    messages = [{ role: 'user', content: [{ type: 'text', text: finalPrompt + "\n\n" + visionPrompt }, { type: 'image_url', imageUrl: image }] }];
                } else {
                    model = "mistral-small-latest"; 
                    messages = [{ role: 'system', content: finalPrompt }];
                    let cleanContext = (context || []).map(msg => ({ role: msg.role, content: msg.content }));
                    messages = messages.concat(cleanContext);
                    messages.push({ role: 'user', content: question });
                }

                const chatResponse = await clientAi.chat.complete({ model: model, temperature: temp, messages: messages }); 
                const answer = chatResponse.choices[0].message.content;
                
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ answer: answer }));

            } catch (e) {
                console.error("ERREUR :", e.message);
                res.writeHead(500, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ answer: "[ERREUR] Problème technique." }));
            }
        });

    } else if (req.method === "POST" && req.url === "/feedback") {
        res.writeHead(200); res.end(JSON.stringify({ status: "ok" }));
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => { console.log(`🚬 L'Aficionado est en ligne sur le port ${PORT} !`); });