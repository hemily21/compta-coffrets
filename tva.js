/* Moteur de calcul TVA des coffrets.
 *
 * Principe (ventilation d'un ensemble à taux multiples) :
 *  1. Le prix payé pour un coffret est réparti entre ses composants au prorata
 *     de leur prix TTC de référence (ex. La Totale : 35/49 livre, 14/49 goodies).
 *     Les remises sont donc réparties de la même façon.
 *  2. Les frais de port suivent le régime des biens expédiés : ils sont répartis
 *     entre les taux au prorata du montant TTC des biens de la commande.
 *  3. Pour chaque taux : TVA = TTC × t / (100 + t), HT = TTC − TVA (arrondi au centime).
 *  4. Un remboursement partiel ou total réduit la commande au prorata.
 *  5. Les frais de paiement réels (API Shopify) sont utilisés quand ils sont connus,
 *     sinon ils sont estimés avec le barème du moyen de paiement. Ils sont répartis
 *     entre les coffrets au prorata de leur montant.
 *
 * Utilisable dans le navigateur (window.TVA) et dans Node (module.exports).
 */
(function (root) {
  const DEFAULT_CONFIG = {
    tauxParDefaut: 20,
    produits: [
      {
        cle: 'totale',
        nom: 'Coffret La Totale',
        motsCles: ['totale'],
        composants: [
          { nom: 'Livre', ttc: 35, taux: 5.5 },
          { nom: 'Goodies', ttc: 14, taux: 20 },
        ],
      },
      {
        cle: 'essentiel',
        nom: "Coffret L'Essentiel",
        motsCles: ['essentiel'],
        composants: [{ nom: 'Livre', ttc: 35, taux: 5.5 }],
      },
    ],
    // Barème utilisé quand Shopify ne fournit pas les frais réels (à ajuster selon ton contrat)
    frais: {
      'Shopify Payments': { pct: 1.5, fixe: 0.25 },
      PayPal: { pct: 2.9, fixe: 0.35 },
    },
    abonnementMensuel: 0, // abonnement Shopify + applis, en €/mois
    nomsTest: [], // noms ajoutés dans les Réglages ; la synchro signale aussi ceux de SHOPIFY_TEST_NAMES
  };

  const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
  const norm = (s) =>
    String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

  function avecDefauts(config) {
    return { ...DEFAULT_CONFIG, ...config, frais: { ...DEFAULT_CONFIG.frais, ...(config && config.frais) } };
  }

  function trouverProduit(titre, config) {
    const t = norm(titre);
    return config.produits.find((p) => p.motsCles.some((m) => m && t.includes(norm(m))));
  }

  function normaliserPaiement(nom) {
    const n = norm(nom);
    if (n.includes('paypal')) return 'PayPal';
    if (n.includes('shopify') || n.includes('stripe') || n.includes('card') || n.includes('carte'))
      return 'Shopify Payments';
    return nom || 'Autre';
  }

  /** Ventile une commande normalisée. Renvoie null si la commande est annulée. */
  function ventiler(cmd, config) {
    config = avecDefauts(config);
    // Une commande annulée ne compte que si une partie de l'argent a été conservée
    if (cmd.annulee) {
      const paye = cmd.total != null ? cmd.total : (cmd.sousTotal || 0) + (cmd.port || 0);
      const encaissee = /^(paid|partially_paid|partially_refunded|refunded)$/i.test(cmd.statut || '');
      if (!encaissee || (cmd.rembourse || 0) >= paye - 0.005) return null;
    }

    const lignes = cmd.lignes || [];
    const totalCatalogue = lignes.reduce((s, l) => s + l.prix * l.qte, 0);
    const biens = cmd.sousTotal != null ? cmd.sousTotal : totalCatalogue;
    const parTaux = {}; // taux -> TTC
    const ajouter = (taux, montant) => (parTaux[taux] = (parTaux[taux] || 0) + montant);
    const parCoffret = {}; // cle -> { qte, ttc }
    const alertes = [];
    const detail = [];

    for (const l of lignes) {
      const part = totalCatalogue > 0 ? (l.prix * l.qte) / totalCatalogue : 0;
      const ttcLigne = biens * part;
      const produit = trouverProduit(l.titre, config);
      const cle = produit ? produit.cle : 'autre';
      const pc = (parCoffret[cle] = parCoffret[cle] || { qte: 0, ttc: 0 });
      pc.qte += l.qte;
      pc.ttc += ttcLigne;
      if (produit) {
        const ref = produit.composants.reduce((s, c) => s + c.ttc, 0);
        for (const c of produit.composants) {
          const m = ref > 0 ? (ttcLigne * c.ttc) / ref : 0;
          ajouter(c.taux, m);
          detail.push({ libelle: `${produit.nom} · ${c.nom}`, qte: l.qte, taux: c.taux, ttc: m });
        }
      } else {
        ajouter(config.tauxParDefaut, ttcLigne);
        detail.push({ libelle: l.titre, qte: l.qte, taux: config.tauxParDefaut, ttc: ttcLigne });
        alertes.push(`Produit non reconnu : « ${l.titre} » (taux ${config.tauxParDefaut} % appliqué)`);
      }
    }

    // Frais de port au prorata des biens, par taux et par coffret
    const port = cmd.port || 0;
    if (port > 0) {
      const totalBiens = Object.values(parTaux).reduce((s, v) => s + v, 0);
      if (totalBiens > 0) {
        for (const [taux, v] of Object.entries({ ...parTaux })) {
          const m = (port * v) / totalBiens;
          ajouter(taux, m);
          detail.push({ libelle: 'Frais de port', qte: 1, taux: Number(taux), ttc: m });
        }
        for (const pc of Object.values(parCoffret)) pc.ttc += (port * pc.ttc) / totalBiens;
      } else {
        ajouter(config.tauxParDefaut, port);
        detail.push({ libelle: 'Frais de port', qte: 1, taux: config.tauxParDefaut, ttc: port });
      }
    }

    const brut = Object.values(parTaux).reduce((s, v) => s + v, 0);
    const rembourse = r2(Math.min(cmd.rembourse || 0, brut));
    const ratio = brut > 0 ? 1 - rembourse / brut : 1;
    if (rembourse > 0) alertes.push(`Remboursement de ${rembourse.toFixed(2)} € déduit`);
    if (cmd.annulee) alertes.push(`Commande annulée mais ${r2(brut - rembourse).toFixed(2)} € conservés`);
    if (cmd.pays && cmd.pays !== 'FR')
      alertes.push(`Livraison hors France (${cmd.pays}) : vérifier le régime TVA (OSS)`);

    // Frais de paiement : réels si connus, sinon estimés sur le montant payé
    const paiement = normaliserPaiement(cmd.paiement);
    let frais = cmd.frais;
    const fraisEstime = frais == null;
    if (fraisEstime) {
      const b = config.frais[paiement];
      frais = b && brut > 0 ? (brut * b.pct) / 100 + b.fixe : 0;
    }
    frais = r2(frais);

    for (const pc of Object.values(parCoffret)) {
      pc.frais = r2(brut > 0 ? (frais * pc.ttc) / brut : 0);
      pc.ttcAvantRemb = r2(pc.ttc);
      pc.ttc = r2(pc.ttc * ratio);
      pc.qteCommandee = pc.qte;
      if (ratio === 0) pc.qte = 0; // commande entièrement remboursée : coffrets non vendus
    }

    const taux = {};
    let tvaBrute = 0;
    for (const [t, ttcBrut] of Object.entries(parTaux)) {
      const tn = Number(t);
      tvaBrute += (ttcBrut * tn) / (100 + tn);
      const ttc = r2(ttcBrut * ratio);
      const tva = r2((ttc * tn) / (100 + tn));
      taux[t] = { ttc, tva, ht: r2(ttc - tva) };
    }
    const somme = (k) => r2(Object.values(taux).reduce((s, v) => s + v[k], 0));
    const coffrets = Object.fromEntries(Object.entries(parCoffret).filter(([k]) => k !== 'autre').map(([k, v]) => [k, v.qte]));

    return {
      ...cmd,
      paiement,
      rembourse,
      ttcAvantRemb: r2(brut),
      frais,
      fraisEstime,
      parCoffret,
      coffrets,
      taux,
      ttc: somme('ttc'),
      ht: somme('ht'),
      tva: somme('tva'),
      tvaBrute: r2(tvaBrute),
      ecartShopify: cmd.taxesShopify != null ? r2(cmd.taxesShopify - tvaBrute) : null,
      detail: detail.map((d) => ({ ...d, ttc: r2(d.ttc) })),
      alertes,
    };
  }

  /** Additionne une liste de commandes ventilées. */
  function totaliser(liste) {
    const t = {
      commandes: 0, ttc: 0, ht: 0, tva: 0, port: 0, frais: 0, fraisEstimes: 0, ttcAvantRemb: 0,
      ecartShopify: 0, remb: { nb: 0, montant: 0 },
      taux: {}, coffrets: {}, parCoffret: {}, paiements: {}, matrice: {},
    };
    const add = (o, k, v) => {
      const x = (o[k] = o[k] || { qte: 0, ttc: 0, frais: 0 });
      x.qte += v.qte; x.ttc += v.ttc; x.frais += v.frais;
    };
    for (const c of liste) {
      t.commandes++;
      t.ttc += c.ttc; t.ht += c.ht; t.tva += c.tva;
      t.ttcAvantRemb += c.ttcAvantRemb;
      t.port += c.port || 0;
      t.frais += c.frais;
      if (c.fraisEstime) t.fraisEstimes += c.frais;
      t.ecartShopify += c.ecartShopify || 0;
      if (c.rembourse > 0) { t.remb.nb++; t.remb.montant += c.rembourse; }
      for (const [k, v] of Object.entries(c.taux)) {
        const x = (t.taux[k] = t.taux[k] || { ttc: 0, ht: 0, tva: 0 });
        x.ttc += v.ttc; x.ht += v.ht; x.tva += v.tva;
      }
      for (const [k, n] of Object.entries(c.coffrets)) t.coffrets[k] = (t.coffrets[k] || 0) + n;
      const m = (t.matrice[c.paiement] = t.matrice[c.paiement] || {});
      for (const [k, v] of Object.entries(c.parCoffret)) { add(t.parCoffret, k, v); add(m, k, v); add(m, '_total', v); }
      const p = (t.paiements[c.paiement] = t.paiements[c.paiement] || { commandes: 0, ttc: 0, frais: 0 });
      p.commandes++; p.ttc += c.ttc; p.frais += c.frais;
    }
    for (const k of ['ttc', 'ht', 'tva', 'port', 'frais', 'fraisEstimes', 'ttcAvantRemb', 'ecartShopify']) t[k] = r2(t[k]);
    t.remb.montant = r2(t.remb.montant);
    const arrondir = (o) => { for (const v of Object.values(o)) for (const k in v) v[k] = r2(v[k]); };
    arrondir(t.taux); arrondir(t.parCoffret); arrondir(t.paiements);
    Object.values(t.matrice).forEach(arrondir);
    return t;
  }

  // ---------- Import CSV Shopify (export « Commandes ») ----------

  function parseCSV(texte) {
    const lignes = [];
    let ligne = [], champ = '', guillemets = false;
    for (let i = 0; i < texte.length; i++) {
      const ch = texte[i];
      if (guillemets) {
        if (ch === '"' && texte[i + 1] === '"') { champ += '"'; i++; }
        else if (ch === '"') guillemets = false;
        else champ += ch;
      } else if (ch === '"') guillemets = true;
      else if (ch === ',') { ligne.push(champ); champ = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && texte[i + 1] === '\n') i++;
        ligne.push(champ); lignes.push(ligne); ligne = []; champ = '';
      } else champ += ch;
    }
    if (champ || ligne.length) { ligne.push(champ); lignes.push(ligne); }
    const entetes = (lignes.shift() || []).map((h) => h.replace(/^﻿/, '').trim());
    return lignes
      .filter((l) => l.some((v) => v !== ''))
      .map((l) => Object.fromEntries(entetes.map((h, i) => [h, l[i] ?? ''])));
  }

  const num = (v) => {
    if (v == null || v === '') return null;
    const s = String(v).replace(/\s|€/g, '');
    return Number(s.includes('.') ? s.replace(/,/g, '') : s.replace(',', '.'));
  };

  /** Transforme l'export CSV des commandes Shopify en commandes normalisées. */
  function depuisCSVShopify(texte) {
    const rows = parseCSV(texte);
    const parNom = new Map();
    for (const r of rows) {
      const nom = r['Name'];
      if (!nom) continue;
      let c = parNom.get(nom);
      if (!c) {
        c = {
          id: r['Id'] || nom,
          nom,
          date: (r['Paid at'] || r['Created at'] || '').slice(0, 10),
          statut: r['Financial Status'],
          paiement: r['Payment Method'] || r['Payment Gateway'] || '',
          pays: r['Shipping Country'] || r['Billing Country'] || '',
          client: r['Billing Name'] || r['Shipping Name'] || '',
          sousTotal: num(r['Subtotal']),
          port: num(r['Shipping']) || 0,
          taxesShopify: num(r['Taxes']),
          total: num(r['Total']),
          rembourse: num(r['Refunded Amount']) || 0,
          annulee: !!r['Cancelled at'] || r['Financial Status'] === 'voided',
          frais: null,
          source: 'csv',
          lignes: [],
        };
        parNom.set(nom, c);
      }
      if (r['Lineitem name'])
        c.lignes.push({
          titre: r['Lineitem name'],
          sku: r['Lineitem sku'],
          qte: num(r['Lineitem quantity']) || 1,
          prix: num(r['Lineitem price']) || 0,
        });
    }
    return [...parNom.values()];
  }

  /** Vrai si le nom du client fait partie des noms de test configurés. */
  function estNomTest(client, config) {
    const n = norm(client).replace(/\s+/g, ' ').trim();
    return !!n && (avecDefauts(config).nomsTest || []).some((t) => norm(t).replace(/\s+/g, ' ').trim() === n);
  }

  const api = { DEFAULT_CONFIG, estNomTest, avecDefauts, ventiler, totaliser, depuisCSVShopify, parseCSV, normaliserPaiement, r2 };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TVA = api;
})(this);
