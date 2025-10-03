const axios = require('axios');
const express = require('express');
const chalk = require('chalk');
const fs = require('fs');

// --- CONFIGURATION ---
const PORT = 3001;
const API_KEY = '7f7700a471beeeb52aecde406a3870ba';
const API_HOST = 'v3.football.api-sports.io';
const LEAGUES_TO_ANALYZE = [
    { name: 'Bundesliga', id: 78 }, { name: 'Bundesliga 2', id: 79 },
    { name: 'Premier League', id: 39 }, { name: 'Championship', id: 40 },
    { name: 'Saudi Pro League', id: 307 }, { name: 'Liga Profesional', id: 128 },
    { name: 'Bundesliga (Autriche)', id: 218 }, { name: 'Pro League', id: 144 },
    { name: 'Série A (Brésil)', id: 71 }, { name: 'Parva Liga', id: 172 },
    { name: 'Primera Division (Chili)', id: 265 }, { name: 'Super League (Chine)', id: 169 },
    { name: 'Primera A', id: 239 }, { name: 'K League 1', id: 292 },
    { name: 'HNL', id: 210 }, { name: 'Superliga', id: 119 },
    { name: 'Premiership', id: 179 }, { name: 'Liga Pro', id: 240 },
    { name: 'La Liga', id: 140 }, { name: 'La Liga 2', id: 141 },
    { name: 'Meistriliiga', id: 327 }, { name: 'MLS', id: 253 },
    { name: 'Veikkausliga', id: 244 }, { name: 'Ligue 1', id: 61 },
    { name: 'Ligue 2', id: 62 }, { name: 'Erovnuli Liga', id: 329 },
    { name: 'Super League (Grèce)', id: 197 }, { name: 'OTP Bank Liga', id: 271 },
    { name: 'Premier Division', id: 357 }, { name: 'Besta deild karla', id: 164 },
    { name: 'Serie A', id: 135 }, { name: 'Serie B', id: 136 },
    { name: 'J1 League', id: 98 }, { name: 'A Lyga', id: 331 },
    { name: 'Liga MX', id: 262 }, { name: 'Eliteserien', id: 103 },
    { name: 'Primera Division (Paraguay)', id: 284 }, { name: 'Eredivisie', id: 88 },
    { name: 'Cymru Premier', id: 110 }, { name: 'Ekstraklasa', id: 106 },
    { name: 'Liga Portugal', id: 94 }, { name: 'Liga Portugal 2', id: 95 },
    { name: 'Fortuna Liga', id: 345 }, { name: 'Liga 1', id: 283 },
    { name: 'Super Liga', id: 286 }, { name: 'Nike Liga', id: 334 },
    { name: 'Prva Liga', id: 373 }, { name: 'Allsvenskan', id: 113 },
    { name: 'Super League (Suisse)', id: 207 }, { name: 'Super Lig', id: 203 },
    { name: 'Premier League (Ukraine)', id: 235 }
];
const MAX_ATTEMPTS = 5;
const MIN_SUCCESS_RATE = 85; // Seuil global pour acceptation (adapté par profil dans generator.js)
const MIN_SAMPLE_SIZE = 10; // Garde-fou pour petits échantillons

// --- VARIABLES GLOBALES ---
let predictions = {};
let analysisStatus = "Analyse non démarrée.";
let totalMatchesFound = 0;
let totalMatchesAnalyzed = 0;
const statsCache = new Map(); // Cache pour les stats des équipes
let backtestData; // Chargé une fois pour la nouvelle méthodologie

const app = express();
const api = axios.create({ baseURL: `https://${API_HOST}`, headers: { 'x-apisports-key': API_KEY }, timeout: 20000 });
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// --- FONCTIONS UTILITAIRES ---
async function getTeamStats(teamId, leagueId, season) {
    const cacheKey = `${teamId}-${leagueId}-${season}`;
    if (statsCache.has(cacheKey)) return statsCache.get(cacheKey);
    let attempts = 0;
    while (attempts < MAX_ATTEMPTS) {
        attempts++;
        try {
            const response = await api.get('/teams/statistics', { params: { team: teamId, league: leagueId, season: season } });
            if (response.data && response.data.response) {
                statsCache.set(cacheKey, response.data.response);
                return response.data.response;
            }
        } catch (error) {
            console.log(chalk.yellow(`      -> Tentative ${attempts}/${MAX_ATTEMPTS} (stats équipe ${teamId}, saison ${season}) échouée`));
        }
        if (attempts < MAX_ATTEMPTS) await sleep(1500);
    }
    console.log(chalk.red(`      -> ERREUR FINALE: Stats pour équipe ${teamId}, saison ${season}`));
    return null;
}

async function getOddsForFixture(fixtureId) {
    let attempts = 0;
    while (attempts < MAX_ATTEMPTS) {
        attempts++;
        try {
            const response = await api.get('/odds', { params: { fixture: fixtureId } });
            if (response.data && response.data.response.length > 0) {
                return response.data.response;
            }
        } catch (error) {
            const status = error.response ? `API Error ${error.response.status}` : error.message;
            console.log(chalk.yellow(`      -> Tentative ${attempts}/${MAX_ATTEMPTS} (cotes) échouée: ${status}`));
        }
        if (attempts < MAX_ATTEMPTS) await sleep(1500);
    }
    console.log(chalk.red(`      -> ERREUR FINALE: Cotes pour match ${fixtureId}`));
    return null;
}

function parseOdds(oddsData) {
    if (!oddsData || oddsData.length === 0) return {};
    const parsed = {};
    const fixtureOdds = oddsData[0];
    for (const bookmaker of fixtureOdds.bookmakers) {
        const matchWinnerBet = bookmaker.bets.find(b => b.id === 1);
        const doubleChanceBet = bookmaker.bets.find(b => b.id === 12);
        if (matchWinnerBet) {
            const homeOdd = parseFloat(matchWinnerBet.values.find(v => v.value === 'Home')?.odd);
            const drawOdd = parseFloat(matchWinnerBet.values.find(v => v.value === 'Draw')?.odd);
            const awayOdd = parseFloat(matchWinnerBet.values.find(v => v.value === 'Away')?.odd);
            if (homeOdd && drawOdd && awayOdd) {
                if (!parsed['draw']) parsed['draw'] = drawOdd;
                const isHomeFavorite = homeOdd < awayOdd;
                if (!parsed['favorite_win']) parsed['favorite_win'] = isHomeFavorite ? homeOdd : awayOdd;
                if (!parsed['outsider_win']) parsed['outsider_win'] = isHomeFavorite ? awayOdd : homeOdd;
                if (doubleChanceBet) {
                    const homeDrawOdd = parseFloat(doubleChanceBet.values.find(v => v.value === 'Home/Draw')?.odd);
                    const awayDrawOdd = parseFloat(doubleChanceBet.values.find(v => v.value === 'Draw/Away')?.odd);
                    if (homeDrawOdd && awayDrawOdd) {
                        if (!parsed['double_chance_favorite']) parsed['double_chance_favorite'] = isHomeFavorite ? homeDrawOdd : awayDrawOdd;
                        if (!parsed['double_chance_outsider']) parsed['double_chance_outsider'] = isHomeFavorite ? awayDrawOdd : homeDrawOdd;
                    }
                }
            }
        }
        for (const bet of bookmaker.bets) {
            switch (bet.id) {
                case 5: bet.values.forEach(v => { const k = `match_${v.value.toLowerCase().replace(' ', '_')}`; if (!parsed[k]) parsed[k] = parseFloat(v.odd); }); break;
                case 8: bet.values.forEach(v => { const k = v.value === 'Yes' ? 'btts' : 'btts_no'; if (!parsed[k]) parsed[k] = parseFloat(v.odd); }); break;
                case 16: bet.values.forEach(v => { const k = `home_${v.value.toLowerCase().replace(' ', '_')}`; if (!parsed[k]) parsed[k] = parseFloat(v.odd); }); break;
                case 17: bet.values.forEach(v => { const k = `away_${v.value.toLowerCase().replace(' ', '_')}`; if (!parsed[k]) parsed[k] = parseFloat(v.odd); }); break;
                case 6: bet.values.forEach(v => { const k = `ht_${v.value.toLowerCase().replace(' ', '_')}`; if (!parsed[k]) parsed[k] = parseFloat(v.odd); }); break;
                case 26: bet.values.forEach(v => { const k = `st_${v.value.toLowerCase().replace(' ', '_')}`; if (!parsed[k]) parsed[k] = parseFloat(v.odd); }); break;
                case 105: bet.values.forEach(v => { const k = `home_ht_${v.value.toLowerCase().replace(' ', '_')}`; if (!parsed[k]) parsed[k] = parseFloat(v.odd); }); break;
                case 106: bet.values.forEach(v => { const k = `away_ht_${v.value.toLowerCase().replace(' ', '_')}`; if (!parsed[k]) parsed[k] = parseFloat(v.odd); }); break;
            }
        }
    }
    return parsed;
}

function bayesianSmooth(avg, matchesPlayed, prior = 1.35, priorStrength = 5) {
    if (matchesPlayed > 0 && matchesPlayed < 6) {
        return (avg * matchesPlayed + prior * priorStrength) / (matchesPlayed + priorStrength);
    }
    return avg;
}

function getIntuitiveBestBet(scores, minConfidence = 60) {
    let bestBet = { market: 'N/A', score: minConfidence };
    let maxConfidence = 0;
    for (const market in scores) {
        const score = scores[market];
        const confidence = Math.abs(score - 50);
        if (score >= minConfidence && confidence > maxConfidence) {
            maxConfidence = confidence;
            bestBet = { market, score };
        }
    }
    if (bestBet.score < minConfidence) return { market: 'N/A', score: 0 }; // Aucun pari fiable
    return bestBet;
}

// --- NOUVELLE FONCTION POUR LA MÉTHODOLOGIE : VALIDER PAR TRANCHE DU BACKTEST ---
function validateMarketByTranche(market, score, backtestData) {
    let trancheKey;
    if (score < 60) trancheKey = '0-59';
    else if (score < 70) trancheKey = '60-69';
    else if (score < 80) trancheKey = '70-79';
    else if (score < 90) trancheKey = '80-89';
    else trancheKey = '90-100';

    const tranche = backtestData.perMarketSummary[market]?.[trancheKey] || {};
    const rate = (tranche.success / tranche.total) * 100 || 0;
    const total = tranche.total || 0;

    // Garde-fou : Si échantillon trop petit, fallback sur taux global ou rejet
    if (total < MIN_SAMPLE_SIZE) {
        const globalTranche = backtestData.globalSummary[trancheKey] || {};
        const globalRate = (globalTranche.success / globalTranche.total) * 100 || 0;
        if (globalRate > MIN_SUCCESS_RATE) {
            console.log(chalk.yellow(`      -> Fallback global pour ${market} (${trancheKey}): ${globalRate.toFixed(2)}%`));
            return true;
        }
        return false;
    }

    // Accepte si taux > seuil (ici global ; adapter par profil dans generator.js)
    const accepted = rate > MIN_SUCCESS_RATE;
    console.log(chalk[accepted ? 'green' : 'red'](`      -> ${market} (${trancheKey}, score=${score.toFixed(0)}%): Taux=${rate.toFixed(2)}% (total=${total}) → ${accepted ? 'Accepté' : 'Rejeté'}`));
    return accepted;
}

// --- MODÈLE POISSON ---
class PoissonModel {
    constructor() { this.factorialCache = { 0: 1, 1: 1 }; }
    _factorial(n) { if (this.factorialCache[n] !== undefined) return this.factorialCache[n]; let r = this._factorial(n - 1) * n; this.factorialCache[n] = r; return r; }
    poissonProbability(k, lambda) { if (lambda <= 0 || k < 0) return k === 0 ? 1 : 0; return (Math.pow(lambda, k) * Math.exp(-lambda)) / this._factorial(k); }
    
    _calculateProbs(lambda) {
        const probs = Array(7).fill(0).map((_, k) => this.poissonProbability(k, lambda));
        const cumulativeProbs = probs.reduce((acc, p, i) => { acc.push((acc[i-1] || 0) + p); return acc; }, []);
        return {
            'over_0.5': (1 - cumulativeProbs[0]) * 100, 'under_0.5': cumulativeProbs[0] * 100,
            'over_1.5': (1 - cumulativeProbs[1]) * 100, 'under_1.5': cumulativeProbs[1] * 100,
            'over_2.5': (1 - cumulativeProbs[2]) * 100, 'under_2.5': cumulativeProbs[2] * 100,
            'over_3.5': (1 - cumulativeProbs[3]) * 100, 'under_3.5': cumulativeProbs[3] * 100,
        };
    }

    predict(lambdas, homeStats, awayStats, projectedHomeGoals, projectedAwayGoals) {
        const { home, away, ht, st, home_ht, home_st, away_ht, away_st } = lambdas;
        const markets = {};
        
        Object.assign(markets, ...Object.entries({ home, away, ht, st, home_ht, home_st, away_ht, away_st })
            .map(([prefix, lambda]) => {
                const segmentProbs = this._calculateProbs(lambda);
                const renamedProbs = {};
                for (const key in segmentProbs) { renamedProbs[`${prefix}_${key}`] = segmentProbs[key]; }
                return renamedProbs;
            }));

        const maxGoals = 8;
        const scoreProbabilities = Array(maxGoals + 1).fill(0).map(() => Array(maxGoals + 1).fill(0));
        let homeWinProb = 0, awayWinProb = 0, drawProb = 0;

        for (let i = 0; i <= maxGoals; i++) {
            for (let j = 0; j <= maxGoals; j++) {
                const prob = this.poissonProbability(i, home) * this.poissonProbability(j, away);
                scoreProbabilities[i][j] = prob;
                if (i > j) homeWinProb += prob;
                else if (j > i) awayWinProb += prob;
                else drawProb += prob;
            }
        }

        // Ajustement avec contexte (forme) et disparité des buts
        const homeFormFactor = homeStats.form ? (parseFloat(homeStats.form) / 100) : 0.5;
        const awayFormFactor = awayStats.form ? (parseFloat(awayStats.form) / 100) : 0.5;
        const goalDisparity = Math.abs(projectedHomeGoals - projectedAwayGoals);
        const disparityBoost = goalDisparity > 0.5 ? 1 + (goalDisparity - 0.5) * 0.2 : 1;
        homeWinProb *= (1 + (homeFormFactor - awayFormFactor) * 0.3) * disparityBoost;
        awayWinProb *= (1 + (awayFormFactor - homeFormFactor) * 0.3) * disparityBoost;
        const totalProb = homeWinProb + awayWinProb + drawProb;
        markets['home_win'] = (homeWinProb / totalProb) * 100;
        markets['away_win'] = (awayWinProb / totalProb) * 100;
        markets['draw'] = (drawProb / totalProb) * 100;
        markets['favorite_win'] = Math.max(markets['home_win'], markets['away_win']);
        markets['outsider_win'] = Math.min(markets['home_win'], markets['away_win']);
        markets['double_chance_favorite'] = markets['favorite_win'] + markets['draw'];
        markets['double_chance_outsider'] = markets['outsider_win'] + markets['draw'];
        
        let probBttsNo = 0;
        for (let i = 0; i <= maxGoals; i++) { probBttsNo += scoreProbabilities[i][0] + scoreProbabilities[0][i]; }
        probBttsNo -= scoreProbabilities[0][0];
        markets['btts'] = (1 - probBttsNo) * 100;
        markets['btts_no'] = 100 - markets['btts'];

        const matchProbs = this._calculateProbs(home + away);
        for (const key in matchProbs) { markets[`match_${key}`] = matchProbs[key]; }
        
        return { markets };
    }
}

// --- MOTEUR DE PRÉDICTION ---
async function runPredictionEngine() {
    analysisStatus = "Analyse en cours...";
    totalMatchesFound = 0;
    totalMatchesAnalyzed = 0;
    predictions = {};
    console.log(chalk.blue.bold("--- Démarrage du moteur de prédiction ---"));
    const season = new Date().getFullYear();
    const poisson = new PoissonModel();

    // Chargement du backtest pour la nouvelle méthodologie
    try {
        backtestData = JSON.parse(fs.readFileSync('bilan_backtest.json', 'utf8'));
        console.log(chalk.green("   -> Backtest chargé pour validation par tranche."));
    } catch (error) {
        console.error(chalk.red("Erreur : bilan_backtest.json non trouvé. Lance backtest.js d'abord."));
        return;
    }

    // Marchés à faible occurrence à exclure (basé sur le backtest, <20 occurrences)
    const lowOccurrenceMarkets = [
        'away_ht_over_3.5', 'home_ht_over_3.5', 'away_st_over_3.5', 'home_st_over_3.5'
    ];

    for (const league of LEAGUES_TO_ANALYZE) {
        console.log(chalk.cyan.bold(`\n[${LEAGUES_TO_ANALYZE.indexOf(league) + 1}/${LEAGUES_TO_ANALYZE.length}] Analyse de : ${league.name}`));
        try {
            const roundsResponse = await api.get('/fixtures/rounds', { params: { league: league.id, season: season, current: 'true' } });
            if (!roundsResponse.data?.response?.length) { console.log(chalk.gray(`   -> Pas de journée en cours trouvée.`)); continue; }
            const currentRoundName = roundsResponse.data.response[0];
            console.log(`   - Analyse de la journée : "${currentRoundName}"`);
            const fixturesResponse = await api.get('/fixtures', { params: { league: league.id, season: season, round: currentRoundName } });
            const upcomingMatches = fixturesResponse.data.response.filter(f => f.fixture.status.short === 'NS');
            
            totalMatchesFound += upcomingMatches.length;
            if (upcomingMatches.length === 0) { console.log(chalk.gray(`   -> Aucun match à venir dans cette journée.`)); continue; }
            
            console.log(`   - ${upcomingMatches.length} match(s) à venir trouvé(s).`);
            predictions[league.name] = [];

            for (const fixture of upcomingMatches) {
                const matchLabel = `${fixture.teams.home.name} vs ${fixture.teams.away.name}`;
                console.log(chalk.green(`\n    Calcul pour : ${matchLabel}`));
                const [homeStats, awayStats, oddsData] = await Promise.all([
                    getTeamStats(fixture.teams.home.id, league.id, season),
                    getTeamStats(fixture.teams.away.id, league.id, season),
                    getOddsForFixture(fixture.fixture.id)
                ]);
                if (!homeStats || !awayStats) { console.log(chalk.red(`      -> Échec: Stats manquantes.`)); continue; }

                totalMatchesAnalyzed++;
                
                const parsedOdds = parseOdds(oddsData);
                let homeAvgFor = parseFloat(homeStats.goals.for.average.total) || 0;
                let homeAvgAgainst = parseFloat(homeStats.goals.against.average.total) || 0;
                let awayAvgFor = parseFloat(awayStats.goals.for.average.total) || 0;
                let awayAvgAgainst = parseFloat(awayStats.goals.against.average.total) || 0;

                const matchesPlayed = homeStats.fixtures.played.total;
                let isEarlySeason = matchesPlayed < 6;

                // Gestion début de saison avec données de la saison précédente
                if (isEarlySeason) {
                    console.log(chalk.yellow(`      -> Début de saison détecté (${matchesPlayed} matchs). Application des corrections.`));
                    const prevHomeStats = await getTeamStats(fixture.teams.home.id, league.id, season - 1);
                    const prevAwayStats = await getTeamStats(fixture.teams.away.id, league.id, season - 1);
                    let stabilityBoost = 1;
                    if (prevHomeStats && prevAwayStats) {
                        const prevHomeAvgFor = parseFloat(prevHomeStats.goals.for.average.total) || homeAvgFor;
                        const prevAwayAvgFor = parseFloat(prevAwayStats.goals.for.average.total) || awayAvgFor;
                        const homeStability = Math.abs(prevHomeAvgFor - homeAvgFor) < 0.5 ? 1.1 : 1;
                        const awayStability = Math.abs(prevAwayAvgFor - awayAvgFor) < 0.5 ? 1.1 : 1;
                        stabilityBoost = (homeStability + awayStability) / 2;
                        homeAvgFor = (0.8 * (prevHomeAvgFor || homeAvgFor)) + (0.2 * homeAvgFor);
                        homeAvgAgainst = (0.8 * (parseFloat(prevHomeStats.goals.against.average.total) || homeAvgAgainst)) + (0.2 * homeAvgAgainst);
                        awayAvgFor = (0.8 * (prevAwayAvgFor || awayAvgFor)) + (0.2 * awayAvgFor);
                        awayAvgAgainst = (0.8 * (parseFloat(prevAwayStats.goals.against.average.total) || awayAvgAgainst)) + (0.2 * awayAvgAgainst);
                    }
                    homeAvgFor = bayesianSmooth(homeAvgFor, matchesPlayed) * stabilityBoost;
                    homeAvgAgainst = bayesianSmooth(homeAvgAgainst, matchesPlayed) * stabilityBoost;
                    awayAvgFor = bayesianSmooth(awayAvgFor, matchesPlayed) * stabilityBoost;
                    awayAvgAgainst = bayesianSmooth(awayAvgAgainst, matchesPlayed) * stabilityBoost;
                }

                const projectedHomeGoals = (homeAvgFor + awayAvgAgainst) / 2;
                const projectedAwayGoals = (awayAvgFor + homeAvgAgainst) / 2;

                // Application du lambdaBoost pour matchs matures
                const lambdaBoost = matchesPlayed >= 6 ? 1.1 : 1;
                const lambdas = {
                    home: projectedHomeGoals * lambdaBoost,
                    away: projectedAwayGoals * lambdaBoost,
                    ht: ((projectedHomeGoals + projectedAwayGoals) * 0.45) * lambdaBoost,
                    st: ((projectedHomeGoals + projectedAwayGoals) * 0.55) * lambdaBoost,
                    home_ht: (projectedHomeGoals * 0.45) * lambdaBoost,
                    home_st: (projectedHomeGoals * 0.55) * lambdaBoost,
                    away_ht: (projectedAwayGoals * 0.45) * lambdaBoost,
                    away_st: (projectedAwayGoals * 0.55) * lambdaBoost
                };

                const poissonPreds = poisson.predict(lambdas, homeStats, awayStats, projectedHomeGoals, projectedAwayGoals);
                let confidenceScores = poissonPreds.markets;

                // Ajustement de calibration pour les marchés basés sur les résultats
                for (const market in confidenceScores) {
                    if (['draw', 'favorite_win', 'outsider_win'].includes(market)) {
                        confidenceScores[market] *= 1.2;
                    }
                }

                // Nouvelle méthodologie : Filtrer les scores par validation de tranche
                const filteredScores = {};
                for (const market in confidenceScores) {
                    if (lowOccurrenceMarkets.includes(market)) continue; // Garder l'exclusion
                    const score = confidenceScores[market];
                    if (validateMarketByTranche(market, score, backtestData)) {
                        filteredScores[market] = score;
                    }
                }

                // Filtrer les matchs à faible confiance globale (max <60%)
                const maxConfidence = Math.max(...Object.values(filteredScores));
                if (maxConfidence < 60) {
                    console.log(chalk.yellow(`      -> Match ${matchLabel} exclu : aucune prédiction valide avec confiance ≥60%.`));
                    continue;
                }

                const fixtureDate = new Date(fixture.fixture.date);
                predictions[league.name].push({
                    matchLabel,
                    homeTeam: fixture.teams.home.name,
                    awayTeam: fixture.teams.away.name,
                    homeLogo: fixture.teams.home.logo,
                    awayLogo: fixture.teams.away.logo,
                    date: fixtureDate.toLocaleDateString('fr-FR'),
                    time: fixtureDate.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }),
                    scores: filteredScores, // Seulement les validés par tranche
                    odds: parsedOdds,
                    isEarlySeason
                });
                await sleep(500);
            }
        } catch (error) {
            console.log(chalk.red.bold(`\n   ❌ ERREUR pour ${league.name}: ${error.message}`));
        }
    }
    analysisStatus = `Prédictions prêtes. ${totalMatchesAnalyzed} matchs analysés sur ${totalMatchesFound} trouvés.`;
    console.log(chalk.blue.bold("\n--- PRÉDICTIONS TERMINÉES ---"));
    try {
        fs.writeFileSync('predictions_du_jour.json', JSON.stringify(predictions, null, 2));
        console.log(chalk.magenta.bold('-> Prédictions sauvegardées dans le fichier predictions_du_jour.json'));
    } catch (error) {
        console.error(chalk.red('Erreur lors de la sauvegarde du fichier JSON:'), error);
    }
}

// --- SERVEUR WEB ---
app.get('/', (req, res) => {
    let html = `
        <!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><title>Prédictions des Matchs</title>
        <style>
            body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background-color: #121212; color: #e0e0e0; margin: 0; padding: 20px; }
            h1, h2 { color: #bb86fc; border-bottom: 2px solid #373737; padding-bottom: 10px; }
            .status { background-color: #1e1e1e; border: 1px solid #373737; padding: 15px; border-radius: 8px; margin-bottom: 20px; font-size: 1.1em; }
            .league-container { margin-bottom: 30px; }
            table { width: 100%; border-collapse: collapse; background-color: #1e1e1e; border-radius: 8px; overflow: hidden; }
            th, td { padding: 12px 15px; text-align: left; border-bottom: 1px solid #373737; }
            th { background-color: #2a2a2a; }
            summary { cursor: pointer; padding: 12px 15px; background-color: #1e1e1e; font-style: italic; color: #aaa; }
            summary:hover { background-color: #2a2a2a; }
            .details-table { margin: 10px 20px; }
            .score { font-weight: bold; }
            .score-high { color: #03dac6; } .score-mid { color: #f0e68c; } .score-low { color: #cf6679; }
            .score-very-high { color: #00ff00; font-weight: bold; } /* Pour 90-100% */
            .na { color: #666; }
            .early-season-tag { background-color: #ffc107; color: black; font-size: 0.8em; padding: 2px 6px; border-radius: 4px; }
        </style>
        </head><body>
            <h1>Prédictions des Matchs à Venir</h1>
            <div class="status"><strong>Statut :</strong> ${analysisStatus}</div>`;
    if (Object.keys(predictions).length > 0) {
        for (const leagueName in predictions) {
            html += `<div class="league-container"><h2>${leagueName}</h2><table>
                        <thead><tr><th>Match</th><th>Date</th><th>Heure</th><th>Marché le + Fiable</th></tr></thead><tbody>`;
            predictions[leagueName].forEach(match => {
                const bestBet = getIntuitiveBestBet(match.scores, 60);
                const scoreClass = bestBet.score >= 90 ? 'score-very-high' : bestBet.score >= 75 ? 'score-high' : bestBet.score >= 60 ? 'score-mid' : 'score-low';
                const bestBetOdd = match.odds[bestBet.market];
                const earlySeasonTag = match.isEarlySeason ? '<span class="early-season-tag">Début de Saison</span>' : '';
                html += `
                    <tr>
                        <td>${match.matchLabel} ${earlySeasonTag}</td>
                        <td>${match.date}</td>
                        <td>${match.time}</td>
                        <td>${bestBet.market} <span class="score ${scoreClass}">(${Math.round(bestBet.score)}%)</span> @ ${bestBetOdd ? bestBetOdd.toFixed(2) : '<span class="na">N/A</span>'}</td>
                    </tr>
                    <tr><td colspan="4" style="padding:0;">
                        <details>
                            <summary>Voir tous les scores et cotes (filtrés par tranche backtest)</summary>
                            <table class="details-table">
                                <thead><tr><th>Marché</th><th>Score de Confiance</th><th>Cote</th></tr></thead>
                                <tbody>`;
                const sortedMarkets = Object.keys(match.scores).sort();
                for (const market of sortedMarkets) {
                    const score = match.scores[market];
                    const odd = match.odds[market];
                    const sClass = score >= 90 ? 'score-very-high' : score >= 75 ? 'score-high' : score >= 60 ? 'score-mid' : 'score-low';
                    html += `<tr>
                                <td>${market}</td>
                                <td class="score ${sClass}">${Math.round(score)}%</td>
                                <td>${odd ? odd.toFixed(2) : '<span class="na">N/A</span>'}</td>
                            </tr>`;
                }
                html += `</tbody></table></details></td></tr>`;
            });
            html += `</tbody></table></div>`;
        }
    } else {
        html += `<p>Aucune prédiction à afficher. L'analyse est peut-être en cours...</p>`;
    }
    html += `</body></html>`;
    res.send(html);
});

// --- DÉMARRAGE ---
app.listen(PORT, () => {
    console.log(chalk.inverse(`\n🚀 Serveur de prédiction démarré. Ouvrez http://localhost:${PORT} dans votre navigateur.`));
    runPredictionEngine();
});
