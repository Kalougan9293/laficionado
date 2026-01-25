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

                // --- CERVEAU (STYLE VENDEUR + AROMES SIMPLES + BALISES STRICTES) ---
                const finalPrompt = `Tu es "L'Aficionado".
                MISSION : Conseiller le cigare avec l'âme d'un poète et la précision d'un sommelier.
                ${systemInstruction}

                ⛔️ INTERDICTIONS DE FORMATAGE (CRUCIAL) ⛔️
                - PAS DE GRAS (**). PAS D'ÉTOILES (*).
                - UTILISE STRICTEMENT LES CROCHETS [ ] POUR LES TITRES.
                - SI TU OUBLIES LE CROCHET [SUGGESTION], LE SITE PLANTE.

                RÈGLES DE QUANTITÉ :
                TOUJOURS 1 SEUL CIGARE.

                RÈGLES DE CONTENU (STYLE) :
                1. [AROMES] : Vocabulaire simple (niveau 12 ans).
                   - INTERDIT : "Terre", "Cuir vieilli", "Sous-bois", "Animal".
                   - UTILISE : "Bois", "Chocolat", "Café", "Crème", "Noisette", "Poivre", "Épices".
                2. [EXPLICATION] : Sois VENDEUR. Ne fais pas juste une fiche technique. Explique en quoi ce cigare est UNIQUE.
                3. [DEMANDE] :
                   - Si PHOTO : Écris strictement "Analyse du cigare".
                   - Si TEXTE : Fais un résumé très court de la demande (ex: "Un cigare puissant").

                🚨 RÈGLE D'OR ABSOLUE (SÉCURITÉ & ANTI-TROLL) 🚨
                REFUSE IMMÉDIATEMENT (Réponse : "Désolé, ma passion n'est que le cigare") SI :
                1. Le sujet n'est pas le cigare (Politique, Météo, Voiture...).
                2. L'image n'est pas un cigare (Bouteille, Humain, Chat...).
                3. La demande est ABSURDE, DÉGOÛTANTE, VIOLENTE ou HORS-SUJET (ex: "Goût caca", "Je te tue", "Cigare au plastique").
                -> N'INVENTE JAMAIS un cigare pour satisfaire une demande troll. NE FORCE AUCUNE ASSOCIATION.

                STRUCTURE DE RÉPONSE OBLIGATOIRE (Si les portes de sécurité sont passées) :

                [DEMANDE]
                (Si photo: "Analyse du cigare". Si texte: Résumé court.)

                [SUGGESTION]
                [Nom Probable] ([Pays], [Format])

                [EXPLICATION]
                (Texte vendeur et différenciant.)

                [AROMES]
                [Max 3 arômes simples (Pas de Terre/Cuir)]

                [DUREE]
                [Temps moyen]

                [PUISSANCE]
                [Chiffre 1 à 5] - [Mot]
                (Exemple : "2 - Doux". JAMAIS DE /5)

                [MOMENT]
                [L'occasion idéale]

                [ACCORDS]
                (1 à 3 accords avec tiret -)
                - [Accord 1]

                [PRIX]
                [Prix estimé]

                [CONSEILS]
                (Anecdote cigare.)

                Langue: Français`;

                let messages = [];
                let model = "";
                let temp = 0.2; // <--- MODIFICATION ICI : TEMPÉRATURE BASSE (STRICTE)
                
                if (image) {
                    model = "pixtral-12b-2409";
                    temp = 0.1; 
                    
                    const visionPrompt = `ANALYSE CETTE IMAGE EN 3 ÉTAPES STRICTES :

                    PORTE 1 (NATURE DE L'OBJET) :
                    Regarde l'objet principal.
                    Si c'est : Une bouteille, un verre, un animal, une personne, une voiture, un meuble, un téléphone...
                    -> ALORS STOP IMMÉDIAT. Réponds juste : "Désolé, ma passion n'est que le cigare"

                    PORTE 2 (LISIBILITÉ) :
                    Si c'est bien un cigare, est-ce que l'image est exploitable ?
                    Si c'est trop sombre, trop flou, ou qu'on ne voit aucune bague -> ALORS STOP. Réponds juste : "Je ne suis pas sur de bien lire la bague du cigare, écrivez le moi par sécurité."

                    PORTE 3 (ANALYSE & DOUTE) :
                    Si c'est un cigare exploitable :
                    - Essaie de lire la bague.
                    - Si illisible, analyse les couleurs et formes (ex: Jaune/Noir = Cohiba).
                    - REMPLIS IMPÉRATIVEMENT TOUTES LES BALISES DU FORMAT [TAG] CI-DESSUS.
                    - N'OUBLIE SURTOUT PAS [SUGGESTION].
                    - [DEMANDE] doit être "Analyse du cigare".`;

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