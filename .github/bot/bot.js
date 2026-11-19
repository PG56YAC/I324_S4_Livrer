// Bot « Livrer » (I324, S4).
// Il lit, sur la branche livrer/<pseudo>, le Dockerfile, le workflow .github/workflows/ci.yml,
// le fichier de réponses et le résultat réel des exécutions et des images publiées (API GitHub),
// puis répond par un commentaire sur le dernier commit.
// Déclenché à la fin de chaque exécution du workflow « CI », et au push quand le workflow est illisible.
// Le jeton des workflows est limité à 1000 appels par heure et par dépôt : chaque donnée est lue une fois.
'use strict';
const fs = require('fs');
const { execFileSync } = require('child_process');
const yaml = require('js-yaml');

const env = process.env;
const REPO = env.REPO;
const [PROPRIO, NOM_REPO] = REPO.split('/');
const IMAGE = `ghcr.io/${PROPRIO.toLowerCase()}/${NOM_REPO.toLowerCase()}`;
const FICHIER_CI = '.github/workflows/ci.yml';

const git = (...a) => { try { return execFileSync('git', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 50e6 }).trim(); } catch { return null; } };
const lire = (ref, f) => git('show', `${ref}:${f}`);
const normaliser = (t) => String(t).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[`'"]/g, '').replace(/\s+/g, ' ').trim();

let appels = 0;
async function api(chemin) {
    appels++;
    const url = chemin.startsWith('https://') ? chemin : `https://api.github.com${chemin}`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${env.GH_TOKEN}`, Accept: 'application/vnd.github+json' } });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`API ${r.status} sur ${url}`);
    return r.json();
}
const memo = (f) => { let p = null; return () => (p = p || f()); };
const cache = { jobs: {} };
const jobsDe = async (id) => (cache.jobs[id] = cache.jobs[id] || ((await api(`/repos/${REPO}/actions/runs/${id}/jobs?per_page=100`)) || {}).jobs || []);
// Versions de l'image publiée (paquet lié au dépôt)
const versionsImage = memo(async () => {
    const v = await api(`/users/${PROPRIO}/packages/container/${NOM_REPO.toLowerCase()}/versions?per_page=100`);
    return Array.isArray(v) ? v : [];
});

// ---------------------------------------------------------------------------------------------
// Lecture des fichiers de l'élève
// ---------------------------------------------------------------------------------------------
function lireWorkflow(texte) {
    if (texte === null) return { absent: true };
    try {
        const w = yaml.load(texte);
        return w && typeof w === 'object' ? { w } : { erreur: 'le fichier est vide.' };
    } catch (e) {
        const ligne = e.mark ? ` (ligne ${e.mark.line + 1})` : '';
        return { erreur: `YAML illisible${ligne} : ${String(e.reason || e.message).split('\n')[0]}. Vérifiez l'indentation (espaces, jamais de tabulations).` };
    }
}
const jobs = (w) => (w && w.jobs && typeof w.jobs === 'object' ? Object.values(w.jobs).filter((j) => j && typeof j === 'object') : []);
const etapes = (j) => (Array.isArray(j.steps) ? j.steps.filter((s) => s && typeof s === 'object') : []);
const texteJob = (j) => etapes(j).map((s) => `${s.uses || ''} ${s.run || ''} ${JSON.stringify(s.with || {})}`).join('\n');
const texteWf = (w) => jobs(w).map(texteJob).join('\n');
const permsPaquets = (w) => {
    const p = [w && w.permissions, ...jobs(w).map((j) => j.permissions)];
    return p.some((x) => x === 'write-all' || (x && typeof x === 'object' && x.packages === 'write'));
};
function lireReponses(t) {
    if (t === null) return null;
    const r = {};
    for (const l of t.split(/\r?\n/)) {
        const m = /^\s*[-*]?\s*\**(q[0-9]+)\**\s*:\s*(.*)$/i.exec(l);
        if (m) r[m[1].toLowerCase()] = m[2].trim();
    }
    return r;
}
// lodash <= 4.17.23 est vulnérable (GHSA-35jh-r3h4-6jhm et suivantes)
function lodashVulnerable(lock) {
    try {
        const v = JSON.parse(lock).packages['node_modules/lodash'];
        if (!v) return false;
        const [a, b, c] = v.version.split('.').map(Number);
        return a < 4 || (a === 4 && (b < 17 || (b === 17 && c <= 23)));
    } catch { return true; }
}

// ---------------------------------------------------------------------------------------------
// Contexte d'un commit
// ---------------------------------------------------------------------------------------------
function contexte({ pseudo, sha, runs, coupure }) {
    const termines = runs.filter((r) => r.status === 'completed' && (!coupure || r.created_at <= coupure));
    const lu = lireWorkflow(lire(sha, FICHIER_CI));
    return {
        pseudo, sha, termines,
        w: lu.w || null, erreurYaml: lu.erreur || null,
        reponses: lireReponses(lire(sha, `reponses/${pseudo}.md`)),
        dockerfile: lire(sha, 'Dockerfile'),
        lock: lire(sha, 'package-lock.json'),
        dependabot: lire(sha, '.github/dependabot.yml') || lire(sha, '.github/dependabot.yaml'),
        workflowDe: (s) => lireWorkflow(lire(s, FICHIER_CI)).w || null,
        depuisMain: git('merge-base', '--is-ancestor', 'origin/main', sha) !== null,
        runCourant: termines.find((r) => r.head_sha === sha) || null,
    };
}
const OK = { ok: true };
// Une exécution verte dont le workflow remplit la condition
function verte(c, condition) {
    return c.termines.find((r) => r.conclusion === 'success' && condition(c.workflowDe(r.head_sha), r));
}
function rougeOuAttente(c, quoi) {
    if (c.runCourant && c.runCourant.conclusion !== 'success') return { ok: false, aide: 'Votre CI est rouge. Ouvrez l\'onglet **Actions**, cliquez sur la dernière exécution et lisez l\'étape en échec.' };
    return { ok: false, aide: `${quoi} est prêt, mais je n'ai encore vu aucune exécution verte de la CI avec cette version. Poussez et suivez-la dans l'onglet **Actions**.` };
}
const construitImage = (w) => /docker build|docker\/build-push-action|docker buildx build/.test(texteWf(w));
const publieImage = (w, pseudo) => {
    const t = texteWf(w);
    return /ghcr\.io/.test(t) && (/docker push/.test(t) || /"push":\s*true/.test(t)) && t.includes(`${IMAGE}:${pseudo}`) && permsPaquets(w);
};
const audit = (w) => /npm audit[^\n]*--audit-level[= ](high|moderate|low)/.test(texteWf(w));

// ---------------------------------------------------------------------------------------------
// Les missions
// ---------------------------------------------------------------------------------------------
const MISSIONS = [
    {
        titre: 'Rejoindre l\'équipe',
        consigne: () => ['Suivez la mission 1 du README.'],
        verifier: async (c) => {
            if (!c.depuisMain) return { ok: false, aide: 'Votre branche ne part pas de `main`. Recréez-la depuis `origin/main`.' };
            if (!c.reponses) return { ok: false, aide: `Le fichier \`reponses/${c.pseudo}.md\` est introuvable sur votre branche.` };
            if (!/hello from docker/.test(normaliser(c.reponses.q1 || ''))) return { ok: false, aide: '`q1` : recopiez la première phrase affichée par `docker run hello-world`.' };
            return OK;
        },
        bilan: () => [
            'Docker fonctionne sur votre PC. `docker run hello-world` a téléchargé une **image** depuis un **registre** (Docker Hub), puis l\'a lancée dans un **conteneur**.',
            'Aujourd\'hui, c\'est le pipeline qui fabrique l\'image de l\'application, et vous qui la publiez dans un registre.',
        ],
    },
    {
        titre: 'Mettre l\'application en boîte',
        consigne: () => [
            '> « Je veux lancer l\'application sur n\'importe quelle machine qui a Docker, sans installer Node.js. Et seulement ce qui sert en production. »',
            '> — Léa, responsable technique',
            '',
            'Écrivez le `Dockerfile` à la racine du projet (la fiche papier vous aide), puis, dans le terminal :',
            '```',
            'docker build -t todo .',
            'docker run -p 3000:3000 todo',
            '```',
            'Ouvrez http://localhost:3000 et ajoutez une tâche. Recopiez à la ligne `q2:` la dernière phrase affichée par le conteneur au démarrage. Arrêtez-le avec `Ctrl+C`.',
        ],
        verifier: async (c) => {
            const d = c.dockerfile;
            if (d === null) return { ok: false, aide: 'Je ne trouve pas de fichier `Dockerfile` à la racine de votre branche (attention : sans extension, avec un D majuscule).' };
            if (!/^\s*FROM\s+node/im.test(d)) return { ok: false, aide: 'Le `Dockerfile` doit partir d\'une image Node.js (`FROM node:…`).' };
            if (/npm install/.test(d)) return { ok: false, aide: 'Dans une image, on installe exactement les versions du lock : quelle commande npm fait ça ?' };
            if (!/npm ci/.test(d)) return { ok: false, aide: 'Le `Dockerfile` n\'installe pas les dépendances.' };
            if (!/--omit[= ]dev|--production|NODE_ENV[= ]production/.test(d)) return { ok: false, aide: 'Léa ne veut que ce qui sert en production : jest, eslint et les autres outils de développement n\'ont rien à faire dans l\'image.' };
            if (!/^\s*(CMD|ENTRYPOINT)\b/im.test(d)) return { ok: false, aide: 'Le `Dockerfile` ne dit pas quelle commande lancer au démarrage du conteneur.' };
            if (!/listening on port 3000/.test(normaliser(c.reponses.q2 || ''))) return { ok: false, aide: '`q2` : lancez le conteneur et recopiez la dernière phrase qu\'il affiche.' };
            return OK;
        },
        bilan: () => [
            'Une **image** contient tout ce qu\'il faut pour lancer l\'application : le système, Node.js, les dépendances et le code. Le même fichier donne le même résultat sur votre PC, sur celui d\'un collègue et sur un serveur.',
            '`--omit=dev` laisse de côté jest, eslint et les autres outils de développement : l\'image est plus légère et contient moins de code qui pourrait avoir une faille.',
        ],
    },
    {
        titre: 'Le pipeline construit l\'image',
        consigne: () => [
            '> « Je ne veux plus d\'image construite sur le PC de quelqu\'un. C\'est le pipeline qui la construit, à chaque push. »',
            '> — Léa',
            '',
            'Ajoutez à `.github/workflows/ci.yml` un job qui construit l\'image. Sur les machines de GitHub, Docker est déjà installé.',
        ],
        structure: (w) => (construitImage(w) ? OK : { ok: false, aide: 'Je ne vois aucun job qui construit l\'image (`docker build`).' }),
        bilan: () => [
            'L\'image est maintenant fabriquée par une machine neutre, à partir du code du dépôt : c\'est le **build**. Si le `Dockerfile` casse, la CI devient rouge tout de suite, pas le jour de la mise en production.',
        ],
    },
    {
        titre: 'Publier l\'image',
        consigne: (c) => [
            '> « Le serveur de test doit pouvoir récupérer l\'image. Publiez-la dans le registre de GitHub. »',
            '> — Léa',
            '',
            `Nom de l'image, imposé par l'équipe : \`${IMAGE}:${c.pseudo}\``,
            'Le job doit se connecter au registre `ghcr.io` avec le jeton du workflow (`secrets.GITHUB_TOKEN`), puis pousser l\'image. Il doit aussi avoir le droit d\'écrire des paquets : cherchez la clé `permissions` dans la documentation de GitHub Actions.',
        ],
        structure: (w, c) => {
            const t = texteWf(w);
            if (/ghcr\.io\/[^\s"']*[A-Z]/.test(t)) return { ok: false, aide: 'Le registre refuse les majuscules dans le nom d\'une image : tout en minuscules.' };
            if (!/ghcr\.io/.test(t)) return { ok: false, aide: 'Je ne vois pas de connexion au registre `ghcr.io`.' };
            if (!t.includes(`${IMAGE}:${c.pseudo}`)) return { ok: false, aide: `L'image doit s'appeler exactement \`${IMAGE}:${c.pseudo}\`.` };
            if (!permsPaquets(w)) return { ok: false, aide: 'Le workflow n\'a pas le droit d\'écrire dans le registre. Il manque une permission.' };
            if (!publieImage(w, c.pseudo)) return { ok: false, aide: 'L\'image est construite, mais jamais poussée dans le registre.' };
            return OK;
        },
        execution: async (c) => ((await versionsImage()).some((v) => ((v.metadata || {}).container || {}).tags?.includes(c.pseudo)) ? OK
            : { ok: false, aide: `La CI est verte, mais je ne trouve pas l'image \`${IMAGE}:${c.pseudo}\` dans le registre. Regardez le journal de l'étape qui pousse.` }),
        bilan: (c) => [
            `Votre image est dans le **registre** : \`${IMAGE}:${c.pseudo}\`. On la voit sur la page du dépôt, à droite, rubrique **Packages**.`,
            'Un registre est aux images ce que npm est aux paquets JavaScript : un endroit d\'où n\'importe quel serveur autorisé peut les télécharger. Le code reste dans Git, l\'**artefact** construit va dans le registre.',
        ],
    },
    {
        titre: 'Récupérer l\'image',
        consigne: (c) => [
            '> « Prouvez-moi que n\'importe qui peut lancer l\'application à partir du registre. »',
            '> — Marco, testeur',
            '',
            'Sur votre PC :',
            '```',
            `docker pull ${IMAGE}:${c.pseudo}`,
            `docker run -p 3000:3000 ${IMAGE}:${c.pseudo}`,
            '```',
            '`docker pull` affiche une ligne `Digest: sha256:…`. Recopiez ce digest à la ligne `q3:`.',
        ],
        verifier: async (c) => {
            const v = (await versionsImage()).find((x) => ((x.metadata || {}).container || {}).tags?.includes(c.pseudo));
            if (!v) return { ok: false, aide: 'Je ne trouve plus votre image dans le registre.' };
            const m = /sha256:([0-9a-f]{12,64})/i.exec(c.reponses.q3 || '');
            if (!m) return { ok: false, aide: '`q3` : recopiez la ligne `Digest: sha256:…` affichée par `docker pull`.' };
            if (!v.name.toLowerCase().startsWith(`sha256:${m[1].toLowerCase()}`)) return { ok: false, aide: '`q3` : ce n\'est pas le digest de votre dernière image. Refaites `docker pull` : si la CI a republié l\'image, le digest a changé.' };
            return OK;
        },
        bilan: () => [
            'Le **digest** est l\'empreinte exacte de l\'image : deux images au même nom mais au contenu différent ont deux digests différents. Une étiquette comme `:jdupont` peut être déplacée sur une autre image, le digest jamais.',
        ],
    },
    {
        titre: 'Ne pas livrer une faille connue',
        consigne: () => [
            '> « En 2017, Equifax s\'est fait voler les données de 147 millions de personnes par une faille connue depuis deux mois. Je veux que le pipeline refuse de livrer une dépendance qui a une faille grave. »',
            '> — Léa',
            '',
            '1. Ajoutez au pipeline un contrôle des dépendances qui échoue sur les failles **graves** (pas sur les failles modérées).',
            '2. Poussez : la CI doit devenir rouge. Lisez le journal : quel paquet est en cause ? Répondez à la ligne `q4:`.',
            '3. Corrigez la dépendance (le rapport indique la version qui corrige), vérifiez avec `npm test`, puis poussez : la CI doit redevenir verte.',
        ],
        verifier: async (c) => {
            if (!audit(c.w)) return { ok: false, aide: 'Je ne vois pas de contrôle des dépendances qui échoue sur les failles graves. Cherchez les options de `npm audit`.' };
            let rouge = null;
            for (const r of c.termines.filter((x) => x.conclusion === 'failure').slice(0, 5)) {
                if (!audit(c.workflowDe(r.head_sha))) continue;
                if ((await jobsDe(r.id)).some((j) => (j.steps || []).some((s) => s.conclusion === 'failure' && /audit/i.test(s.name)))) { rouge = r; break; }
            }
            if (!rouge) {
                if (!lodashVulnerable(c.lock)) return { ok: false, aide: 'La dépendance est déjà corrigée, mais je n\'ai jamais vu le contrôle échouer. Il manque la preuve du point 2.' };
                return { ok: false, aide: 'Le contrôle est en place. Poussez et regardez la CI échouer (point 2).' };
            }
            if (lodashVulnerable(c.lock)) return { ok: false, aide: 'Bien : la CI refuse la faille. Corrigez maintenant la dépendance (point 3).' };
            if (!verte(c, (w) => audit(w)) || !(c.runCourant && c.runCourant.conclusion === 'success')) return rougeOuAttente(c, 'La correction');
            if (normaliser(c.reponses.q4 || '') !== 'lodash') return { ok: false, aide: '`q4` : quel paquet le rapport désignait-il ?' };
            return OK;
        },
        bilan: () => [
            '`npm audit` compare chaque dépendance à une base de failles publiées. Avec `--audit-level=high`, il échoue seulement sur les failles graves : le pipeline bloque la livraison tant que la dépendance n\'est pas corrigée.',
            'Le rapport proposait `npm audit fix --force` : à éviter les yeux fermés. Il peut installer une version qui casse l\'application (ici, il aurait aussi rétrogradé jest). On corrige la dépendance visée, puis on relance les tests.',
        ],
    },
    {
        titre: 'Être prévenu de la prochaine faille',
        consigne: () => [
            '> « Je ne veux plus découvrir les failles le jour où la CI devient rouge. Je veux que GitHub propose tout seul, chaque semaine, les mises à jour des dépendances npm. »',
            '> — Léa',
            '',
            'Le service s\'appelle **Dependabot**. Il se configure dans un fichier du dossier `.github/` : https://docs.github.com/fr/code-security/dependabot',
        ],
        verifier: async (c) => {
            if (!c.dependabot) return { ok: false, aide: 'Je ne trouve pas le fichier de configuration de Dependabot dans `.github/`.' };
            let d;
            try { d = yaml.load(c.dependabot); } catch { return { ok: false, aide: 'Le fichier de Dependabot est un YAML illisible.' }; }
            if (!d || Number(d.version) !== 2) return { ok: false, aide: 'Le fichier doit commencer par `version: 2`.' };
            const u = (d.updates || []).find((x) => x && x['package-ecosystem'] === 'npm');
            if (!u) return { ok: false, aide: 'Aucune entrée `updates` ne surveille les paquets npm.' };
            if (u.directory !== '/') return { ok: false, aide: '`directory` doit indiquer où se trouve `package.json`.' };
            if (!u.schedule || u.schedule.interval !== 'weekly') return { ok: false, aide: 'Léa veut une vérification chaque semaine.' };
            return OK;
        },
        bilan: () => [
            'Dependabot ouvre tout seul une pull request quand une dépendance a une nouvelle version ou une faille. La CI la teste, un humain relit et fusionne. Ici, il ne s\'active que sur la branche principale : votre fichier est prêt pour le jour où il y entrera.',
            'Les missions obligatoires sont terminées. La suivante est un bonus.',
        ],
    },
    {
        titre: 'Bonus : analyser l\'image',
        consigne: () => [
            '> « `npm audit` ne regarde que les paquets npm. L\'image contient aussi un système Linux, avec ses propres failles. Analysez l\'image entière dans le pipeline. »',
            '> — Sofia, responsable qualité',
            '',
            'Cherchez l\'outil **Trivy** et son action GitHub. Faites-le échouer seulement sur les failles critiques.',
        ],
        structure: (w) => (/aquasecurity\/trivy-action/.test(texteWf(w)) ? OK : { ok: false, aide: 'Je ne vois pas l\'action de Trivy dans votre pipeline.' }),
        bilan: () => [
            'Trivy analyse tout ce qui est dans l\'image : les paquets du système de base autant que ceux de npm. Choisir une image de base légère (`-alpine`, `-slim`) réduit le nombre de failles à surveiller.',
        ],
    },
];

async function verifierMission(m, c) {
    if (m.verifier) return m.verifier(c);
    const s = m.structure(c.w, c);
    if (!s.ok) return s;
    const r = verte(c, (w) => m.structure(w, c).ok);
    if (!r) return rougeOuAttente(c, 'Votre workflow');
    return m.execution ? m.execution(c, r) : OK;
}
async function evaluer(c) {
    let reussies = 0, aide = '';
    for (const m of MISSIONS) {
        const r = await verifierMission(m, c);
        if (!r.ok) { aide = r.aide; break; }
        reussies++;
    }
    return { reussies, aide };
}

// ---------------------------------------------------------------------------------------------
async function main() {
    const res = { commentaire: '', sha: env.SHA };
    const fin = () => { fs.writeFileSync(env.SORTIE, JSON.stringify(res)); console.log(`Appels à l'API : ${appels}`); if (env.AFFICHER) console.log(res.commentaire); };
    const acteur = env.ACTEUR;
    const pseudo = acteur.toLowerCase();
    const branche = env.BRANCHE;
    const sha = env.SHA;
    if (branche !== `livrer/${pseudo}`) {
        if (env.EVENEMENT === 'push' && branche !== 'main') res.commentaire = `@${acteur}\n\nLa branche \`${branche}\` ne correspond à rien ici : je ne regarde que \`livrer/${pseudo}\` (pseudo en minuscules).`;
        return fin();
    }
    if (env.EVENEMENT === 'push') {
        const lu = lireWorkflow(lire(sha, FICHIER_CI));
        if (lu.erreur || lu.absent) res.commentaire = `@${acteur}\n\n### Votre workflow ne peut pas démarrer\n\n> ${lu.absent ? `Le fichier \`${FICHIER_CI}\` a disparu de votre branche.` : lu.erreur}`;
        return fin();
    }
    const runs = (((await api(`/repos/${REPO}/actions/runs?branch=${encodeURIComponent(branche)}&per_page=100`)) || {}).workflow_runs || [])
        .filter((r) => r.name === 'CI').sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    const courant = runs.find((r) => String(r.id) === String(env.RUN_ID));
    const c = contexte({ pseudo, sha, runs, coupure: courant ? courant.created_at : null });
    const apres = await evaluer(c);
    // État juste avant : commit parent, sans l'exécution qui vient de se terminer
    let avantEtat = 0;
    const parent = git('rev-parse', '--verify', '--quiet', `${sha}^`);
    if (parent && courant) avantEtat = (await evaluer(contexte({ pseudo, sha: parent, runs, coupure: new Date(new Date(courant.created_at).getTime() - 1000).toISOString() }))).reussies;

    const n = MISSIONS.length;
    const L = [`@${acteur}`, '', `**Progression : ${apres.reussies} sur ${n}**`, ''];
    if (apres.reussies > avantEtat) {
        for (let i = avantEtat; i < apres.reussies; i++) L.push(`### Mission ${i + 1} réussie : ${MISSIONS[i].titre}`, '', ...MISSIONS[i].bilan(c).flatMap((x) => [x, '']));
        if (apres.reussies === n) L.push('### Terminé', '', 'Toutes les missions sont réussies, bonus compris. Montrez ce message à votre enseignant.');
        else L.push(`### Mission ${apres.reussies + 1} : ${MISSIONS[apres.reussies].titre}`, '', ...MISSIONS[apres.reussies].consigne(c), '');
    } else if (apres.reussies === n) {
        L.push('Toutes les missions sont déjà réussies.');
    } else {
        L.push(`### Mission ${apres.reussies + 1} : pas encore`, '', `> ${apres.aide}`, '');
        if (apres.reussies > 0) L.push('<details><summary>Rappel de la consigne</summary>', '', ...MISSIONS[apres.reussies].consigne(c), '', '</details>', '');
    }
    if (apres.reussies < n) L.push('_Chaque étape se termine par un commit et un push : sans push, je ne vois rien._');
    res.commentaire = L.join('\n');
    return fin();
}

main().catch((e) => {
    console.error(e);
    fs.writeFileSync(env.SORTIE, JSON.stringify({ commentaire: '', sha: env.SHA }));
    console.log(`Appels à l'API : ${appels}`);
});
