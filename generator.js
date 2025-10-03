const express = require('express');
const fs = require('fs');
const chalk = require('chalk');

// --- CONFIGURATION ---
const PORT = 3002;
const MIN_SAMPLE_SIZE = 10; // Garde-fou pour petits échantillons
const MIN_OCCURRENCE_RATE = 1; // % minimum pour considérer un marché
const PROFILES = {
    prudent: { threshold: 90, minBets: 2, maxBets: 3 },
    equilibre: { threshold: 85, minBets: 2, maxBets: 4 },
    audacieux: { threshold: 80, minBets: 2, maxBets: 5 }
};
const MAX_TICKETS_PER_PROFILE = 10; // Limite de tickets générés par profil

// --- VARIABLES GLOBALES ---
let bets = { prudent: [], equilibre: [], audacieux: [] };
let tickets = { prudent: [], equilibre: [], audacieux: [] };
let generationStatus = "Génération des tickets non démarrée.";
let totalTicketsGenerated = 0;
const app = express();

// --- FONCTIONS UTILITAIRES ---
function loadBets() {
    try {
        bets = JSON.parse(fs.readFileSync('generated_bets.json'));
        console.log(chalk.blue('Pronostics chargés depuis generated_bets.json'));
    } catch (error) {
        console.log(chalk.red('Erreur lors de la lecture de generated_bets.json:', error.message));
        generationStatus = "Erreur: generated_bets.json introuvable.";
        return false;
    }
    return true;
}

function generateCombinations(bets, minBets, maxBets) {
    const result = [];
    const generate = (current, start) => {
        if (current.length >= minBets && current.length <= maxBets) {
            result.push([...current]);
        }
        if (current.length >= maxBets) return;
        for (let i = start; i < bets.length; i++) {
            // Éviter les combinaisons avec le même match
            if (!current.some(bet => bet.match === bets[i].match)) {
                current.push(bets[i]);
                generate(current, i + 1);
                current.pop();
            }
        }
    };
    generate([], 0);
    return result;
}

function calculateTicketEV(combination) {
    let combinedOdds = 1;
    let combinedSuccessRate = 1;
    for (const bet of combination) {
        combinedOdds *= parseFloat(bet.odds);
        combinedSuccessRate *= parseFloat(bet.successRate) / 100;
    }
    return combinedSuccessRate * combinedOdds;
}

// --- GÉNÉRATION DES TICKETS ---
function generateTickets() {
    generationStatus = "Génération des tickets en cours...";
    totalTicketsGenerated = 0;
    tickets = { prudent: [], equilibre: [], audacieux: [] };

    console.log(chalk.blue.bold("--- Démarrage du générateur de tickets ---"));

    if (!loadBets()) return;

    for (const [profile, { threshold, minBets, maxBets }] of Object.entries(PROFILES)) {
        console.log(chalk.cyan.bold(`\nGénération pour profil: ${profile}`));
        const validBets = bets[profile].filter(bet => {
            const occurrence = bet.occurrence || 100; // Par défaut si non fourni
            const isValidSample = bet.totalPredictions >= MIN_SAMPLE_SIZE || parseFloat(bet.ci.lower) >= threshold;
            return occurrence >= MIN_OCCURRENCE_RATE && isValidSample;
        });

        if (validBets.length < minBets) {
            console.log(chalk.yellow(`   -> Pas assez de pronostics valides pour ${profile} (${validBets.length} < ${minBets})`));
            continue;
        }

        console.log(chalk.green(`   - ${validBets.length} pronostics valides trouvés pour ${profile}`));
        const combinations = generateCombinations(validBets, minBets, maxBets);

        for (const combination of combinations) {
            const ticket = {
                profile,
                bets: combination.map(bet => ({
                    match: bet.match,
                    league: bet.league,
                    market: bet.market,
                    confidence: bet.confidence,
                    tranche: bet.tranche,
                    successRate: bet.successRate,
                    odds: bet.odds,
                    timestamp: bet.timestamp
                })),
                combinedOdds: combination.reduce((acc, bet) => acc * parseFloat(bet.odds), 1).toFixed(2),
                combinedSuccessRate: combination.reduce((acc, bet) => acc * (parseFloat(bet.successRate) / 100), 1).toFixed(4),
                ev: calculateTicketEV(combination).toFixed(2),
                timestamp: combination[0].timestamp
            };
            tickets[profile].push(ticket);
            totalTicketsGenerated++;
            console.log(chalk.green(`   -> Ticket généré pour ${profile}: ${combination.length} paris, cote=${ticket.combinedOdds}, EV=${ticket.ev}`));
        }

        // Trier par EV décroissant et limiter à MAX_TICKETS_PER_PROFILE
        tickets[profile].sort((a, b) => b.ev - a.ev);
        tickets[profile] = tickets[profile].slice(0, MAX_TICKETS_PER_PROFILE);
        console.log(chalk.magenta(`   -> ${tickets[profile].length} tickets retenus pour ${profile}`));
    }

    generationStatus = `Génération terminée. ${totalTicketsGenerated} tickets générés.`;
    console.log(chalk.blue.bold("\n--- GÉNÉRATION DES TICKETS TERMINÉE ---"));
    try {
        fs.writeFileSync('generated_tickets.json', JSON.stringify(tickets, null, 2));
        console.log(chalk.magenta.bold('-> Tickets sauvegardés dans generated_tickets.json'));
    } catch (error) {
        console.error(chalk.red('Erreur lors de la sauvegarde du fichier JSON:'), error);
    }
}

// --- SERVEUR WEB ---
app.get('/', (req, res) => {
    let html = `
        <!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><title>Tickets de Paris Générés</title>
        <style>
            body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background-color: #121212; color: #e0e0e0; margin: 0; padding: 20px; }
            h1, h2, h3 { color: #bb86fc; border-bottom: 2px solid #373737; padding-bottom: 10px; }
            .status { background-color: #1e1e1e; border: 1px solid #373737; padding: 15px; border-radius: 8px; margin-bottom: 20px; font-size: 1.1em; }
            table { width: 100%; border-collapse: collapse; background-color: #1e1e1e; border-radius: 8px; overflow: hidden; margin-bottom: 20px; }
            th, td { padding: 12px 15px; text-align: left; border-bottom: 1px solid #373737; }
            th { background-color: #2a2a2a; }
            .rate-high { color: #03dac6; font-weight: bold; }
            .ticket { margin-bottom: 30px; padding: 15px; background-color: #1e1e1e; border-radius: 8px; }
        </style>
        </head><body>
            <h1>Tickets de Paris Générés</h1>
            <div class="status"><strong>Statut :</strong> ${generationStatus}</div>`;
    
    for (const profile in tickets) {
        html += `<h2>Profil: ${profile.charAt(0).toUpperCase() + profile.slice(1)} (Seuil: ${PROFILES[profile].threshold}%)</h2>`;
        if (tickets[profile].length === 0) {
            html += `<p>Aucun ticket généré pour ce profil.</p>`;
            continue;
        }
        for (const [index, ticket] of tickets[profile].entries()) {
            html += `
                <div class="ticket">
                    <h3>Ticket #${index + 1} (Cote: ${ticket.combinedOdds}, EV: ${ticket.ev})</h3>
                    <table>
                        <thead><tr><th>Match</th><th>Ligue</th><th>Marché</th><th>Confiance</th><th>Tranche</th><th>Taux Réussite</th><th>Cote</th><th>Date</th></tr></thead>
                        <tbody>`;
            for (const bet of ticket.bets) {
                html += `<tr>
                    <td>${bet.match}</td>
                    <td>${bet.league}</td>
                    <td>${bet.market}</td>
                    <td>${bet.confidence}%</td>
                    <td>${bet.tranche}%</td>
                    <td class="rate-high">${bet.successRate}%</td>
                    <td>${bet.odds}</td>
                    <td>${new Date(bet.timestamp).toLocaleString()}</td>
                </tr>`;
            }
            html += `</tbody></table>
                     <p><strong>Cote combinée:</strong> ${ticket.combinedOdds} | <strong>Probabilité de succès:</strong> ${(ticket.combinedSuccessRate * 100).toFixed(2)}% | <strong>EV:</strong> ${ticket.ev}</p>
                </div>`;
        }
    }
    html += `</body></html>`;
    res.send(html);
});

// --- DÉMARRAGE ---
app.listen(PORT, () => {
    console.log(chalk.inverse(`\n🚀 Serveur de tickets démarré. Ouvrez http://localhost:${PORT} dans votre navigateur.`));
    generateTickets();
});
