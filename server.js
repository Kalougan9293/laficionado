// CORRECTION : Try/catch pour éviter le crash dotenv sur Render
try { require('dotenv').config(); } catch (e) { console.log("Mode Production"); }

const { Mistral } = require('@mistralai/mistralai');
const http = require("http");
const fs = require("fs");
const path = require("path");

const clientAi = new Mistral({apiKey: process.env.MISTRAL_API_KEY});

// --- LOGS (CORRECTION CRASH RENDER) ---
function logActivity(clientName, message) {
    // SÉCURITÉ : On vérifie si le dossier 'logs' existe, sinon on le crée
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

                // --- CERVEAU (Configuration Rapide) ---
                const finalPrompt = `Tu es "L'Aficionado".
                MISSION : Conseiller le cigare comme un mentor humain, chaleureux et distingué.
                ${systemInstruction}

                RÈGLES DE COMPORTEMENT :
                1. 🛑 VIOLENCE / HORS SUJET : Si menaces ou sujet grave sans lien, réponds UNIQUEMENT : "Ma passion n'est que les cigares."
                2. 🍕 ACCORDS METS : Si nourriture citée, trouve le cigare parfait pour l'après-repas.
                3. 🤥 VÉRACITÉ : Ne mens jamais sur l'existence d'un cigare.

                RÈGLES DE FORMATAGE :
                1. Pas de puces, pas de tirets, pas de gras.
                2. Propose 2 cigares par défaut.
                3. Utilise "N°1 :" et "N°2 :" et saute une ligne entre chaque cigare.

                STRUCTURE DE RÉPONSE OBLIGATOIRE :

                [DEMANDE]
                (Synthèse ultra-courte de la demande. Max 10 mots.)

                [SUGGESTION]
                (Format : Nom du cigare + (Pays, Format))
                N°1 : [Nom] ([Pays], [Format])
                N°2 : [Nom] ([Pays], [Format])

                [EXPLICATION]
                (Pourquoi ce choix ? L'histoire ou le caractère du cigare.)

                [AROMES]
                N°1 : [Max 3 arômes dominants]
                N°2 : [Max 3 arômes dominants]

                [DUREE]
                N°1 : [Temps moyen]
                N°2 : [Temps moyen]

                [PUISSANCE]
                (Format STRICT : N°X : Note - Mot. Ex: "N°1 : 3 - Équilibré")
                N°1 : [Note 1] - [Mot]
                N°2 : [Note 2] - [Mot]

                [MOMENT]
                (Le contexte idéal)
                N°1 : [Moment idéal]
                N°2 : [Moment idéal]

                [ACCORDS]
                (Boisson idéale)
                N°1 : [Boisson 1]
                N°2 : [Boisson 2]

                [PRIX]
                N°1 : [Prix unitaire estimé]
                N°2 : [Prix unitaire estimé]

                [CONSEILS]
                (Donne UNE seule astuce d'expert marquante par cigare. Ne décris pas tout le parcours.
                Choisis un angle : l'allumage, la cendre, la rétro-olfaction, ou un moment clé.
                VOCABULAIRE : Si et seulement si tu parles d'une étape, utilise : "Foin (le début)", "Divin (le grand milieu)" ou "Purin (la fin)".
                Sois concis, impactant et élégant.)
                
                N°1 : [Conseil expert ciblé]
                (Important : Saute une ligne vide ici)
                N°2 : [Conseil expert ciblé]

                Langue: Français`;

                let messages = [];
                let model = "";
                
                if (image) {
                    model = "pixtral-12b-2409";
                    messages = [{ role: 'user', content: [{ type: 'text', text: finalPrompt + "\n\nANALYSE PHOTO." }, { type: 'image_url', imageUrl: image }] }];
                } else {
                    model = "mistral-small-latest"; 
                    messages = [{ role: 'system', content: finalPrompt }];
                    let cleanContext = (context || []).map(msg => ({ role: msg.role, content: msg.content }));
                    messages = messages.concat(cleanContext);
                    messages.push({ role: 'user', content: question });
                }

                const chatResponse = await clientAi.chat.complete({ model: model, temperature: 0.6, messages: messages });
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