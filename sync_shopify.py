#!/usr/bin/env python3
"""Récupère les commandes Shopify et les écrit dans data.js pour le dashboard.

Usage :
    python3 sync_shopify.py              # commandes depuis le 1er janvier de l'année dernière
    python3 sync_shopify.py 2025-01-01   # commandes depuis une date

Mode automatique (GitHub Actions) : les réglages et le mot de passe sont lus dans les variables
d'environnement SHOPIFY_* et DASHBOARD_PASSWORD, sans rien demander.

Configuration dans le fichier .env (voir .env.example).
Le fichier data.js est chiffré avec le mot de passe du dashboard (PBKDF2-SHA256 + AES-GCM).
Dépendance : python3 -m pip install cryptography
"""
import base64
import datetime as dt
import getpass
import hashlib
import json
import secrets
import stat
import unicodedata
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ICI = Path(__file__).resolve().parent


ITERATIONS = 600_000  # identique au dashboard


def chiffrer(donnees, mot_de_passe):
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    sel, iv = secrets.token_bytes(16), secrets.token_bytes(12)
    cle = hashlib.pbkdf2_hmac("sha256", mot_de_passe.encode(), sel, ITERATIONS, 32)
    ct = AESGCM(cle).encrypt(iv, json.dumps(donnees, ensure_ascii=False).encode(), None)
    b64 = lambda b: base64.b64encode(b).decode()
    return {"v": 1, "iter": ITERATIONS, "salt": b64(sel), "iv": b64(iv), "ct": b64(ct)}


def lire_env():
    env = {}
    fichier = ICI / ".env"
    if fichier.exists():
        if fichier.stat().st_mode & (stat.S_IRWXG | stat.S_IRWXO):
            fichier.chmod(0o600)
            print("🔐 .env rendu lisible par toi seule (permissions 600).")
        for ligne in fichier.read_text(encoding="utf-8").splitlines():
            ligne = ligne.strip()
            if ligne and not ligne.startswith("#") and "=" in ligne:
                k, v = ligne.split("=", 1)
                env[k.strip()] = v.strip().strip('"').strip("'")
    env.update({k: v for k, v in os.environ.items() if k.startswith("SHOPIFY_") and v})
    return env


def post_json(url, corps, entetes=None):
    req = urllib.request.Request(
        url,
        data=json.dumps(corps).encode(),
        headers={"Content-Type": "application/json", **(entetes or {})},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        sys.exit(f"Erreur Shopify {e.code} : {e.read().decode(errors='replace')[:500]}")


def obtenir_token(env, boutique):
    if env.get("SHOPIFY_ACCESS_TOKEN"):
        return env["SHOPIFY_ACCESS_TOKEN"]
    cid, secret = env.get("SHOPIFY_CLIENT_ID"), env.get("SHOPIFY_CLIENT_SECRET")
    if not (cid and secret) or "COLLE_ICI" in secret:
        sys.exit("❌ Le Client secret n'est pas rempli dans .env (SHOPIFY_CLIENT_SECRET=…).")
    corps = urllib.parse.urlencode(
        {"grant_type": "client_credentials", "client_id": cid, "client_secret": secret}
    ).encode()
    req = urllib.request.Request(
        f"https://{boutique}/admin/oauth/access_token",
        data=corps,
        headers={"Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read())["access_token"]
    except urllib.error.HTTPError as e:
        texte = e.read().decode(errors="replace")
        sys.exit(
            f"❌ Shopify refuse la connexion (erreur {e.code}).\n"
            "Vérifie dans .env : l'adresse de la boutique, le Client ID et le Client secret.\n"
            "Vérifie aussi que l'application est bien installée sur ta boutique (Dev Dashboard → Home → Install).\n"
            f"Détail : {texte[:200] if not texte.lstrip().startswith('<') else 'page d’erreur OAuth'}"
        )


REQUETE = """
query($curseur: String, $filtre: String) {
  orders(first: 100, after: $curseur, query: $filtre, sortKey: CREATED_AT) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id name createdAt processedAt cancelledAt displayFinancialStatus
      paymentGatewayNames
      shippingAddress { countryCodeV2 name }
      billingAddress { name }
      subtotalPriceSet { shopMoney { amount } }
      totalShippingPriceSet { shopMoney { amount } }
      totalTaxSet { shopMoney { amount } }
      totalPriceSet { shopMoney { amount } }
      totalRefundedSet { shopMoney { amount } }
      refunds { createdAt note totalRefundedSet { shopMoney { amount } } }
      lineItems(first: 50) {
        nodes {
          title sku quantity originalUnitPriceSet { shopMoney { amount } }
          lineItemGroup { id title quantity }
        }
      }
      %TRANSACTIONS%
    }
  }
}
"""
TRANSACTIONS = """transactions(first: 20) {
        gateway kind status fees { amount { amount } }
        paymentIcon { altText }
        paymentDetails {
          __typename
          ... on LocalPaymentMethodsPaymentDetails { paymentMethodName }
        }
      }"""


def moyen_de_paiement(o):
    """PayPal peut passer par Shopify Payments : la commande indique alors « shopify_payments »,
    seul le détail de la transaction révèle PayPal."""
    ventes = [
        t for t in o.get("transactions") or []
        if t["status"] == "SUCCESS" and t["kind"] in ("SALE", "CAPTURE")
    ]
    for t in ventes:
        details = t.get("paymentDetails") or {}
        icone = ((t.get("paymentIcon") or {}).get("altText") or "").lower()
        if details.get("__typename") == "PaypalWalletPaymentDetails" or icone == "paypal" or "paypal" in t["gateway"]:
            return "PayPal"
        if details.get("paymentMethodName"):
            return details["paymentMethodName"].capitalize()
    if any(t["gateway"] == "shopify_payments" for t in ventes):
        return "Shopify Payments"
    return " + ".join(o.get("paymentGatewayNames") or [])


def montant(objet):
    return float(objet["shopMoney"]["amount"]) if objet else 0.0


NOMS_TEST = []  # rempli dans main() depuis SHOPIFY_TEST_NAMES


def nom_simple(nom):
    return " ".join(unicodedata.normalize("NFD", nom or "").encode("ascii", "ignore").decode().lower().split())


def normaliser(o, avec_frais):
    frais = None
    if avec_frais:
        frais = sum(
            float(f["amount"]["amount"])
            for t in o.get("transactions") or []
            if t["status"] == "SUCCESS"
            for f in t.get("fees") or []
        )
    return {
        "id": o["id"],
        "nom": o["name"],
        "date": (o.get("processedAt") or o["createdAt"])[:10],
        "statut": o["displayFinancialStatus"],
        "paiement": moyen_de_paiement(o) if avec_frais else " + ".join(o.get("paymentGatewayNames") or []),
        "pays": (o.get("shippingAddress") or {}).get("countryCodeV2") or "",
        "client": (o.get("billingAddress") or {}).get("name") or (o.get("shippingAddress") or {}).get("name") or "",
        "test": any(
            nom_simple((o.get(k) or {}).get("name")) in NOMS_TEST for k in ("billingAddress", "shippingAddress")
        ),
        "sousTotal": montant(o["subtotalPriceSet"]),
        "port": montant(o["totalShippingPriceSet"]),
        "taxesShopify": montant(o["totalTaxSet"]),
        "total": montant(o["totalPriceSet"]),
        "rembourse": montant(o["totalRefundedSet"]),
        "remboursements": [
            {"date": r["createdAt"][:10], "montant": montant(r["totalRefundedSet"]), "motif": r.get("note") or ""}
            for r in o.get("refunds") or []
            if montant(r["totalRefundedSet"]) > 0
        ],
        "annulee": bool(o.get("cancelledAt")) or o["displayFinancialStatus"] == "VOIDED",
        "frais": frais,
        "source": "api",
        "lignes": regrouper_lots(o["lineItems"]["nodes"]),
    }


def regrouper_lots(lignes):
    """Les coffrets vendus en « lot » (bundle) arrivent découpés en composants
    (ex. Livre + Goodies) : on les regroupe en une seule ligne au nom du coffret."""
    resultat, lots = [], {}
    for l in lignes:
        prix = montant(l["originalUnitPriceSet"])
        groupe = l.get("lineItemGroup")
        if not groupe:
            resultat.append({"titre": l["title"], "sku": l.get("sku"), "qte": l["quantity"], "prix": prix})
            continue
        lot = lots.get(groupe["id"])
        if lot is None:
            lot = lots[groupe["id"]] = {"titre": groupe["title"], "sku": None, "qte": groupe["quantity"] or 1, "total": 0.0}
            resultat.append(lot)
        lot["total"] += prix * l["quantity"]
    for lot in lots.values():
        lot["prix"] = round(lot.pop("total") / lot["qte"], 2)
    return resultat


def main():
    try:
        import cryptography  # noqa: F401
    except ImportError:
        sys.exit("Installe d'abord la bibliothèque de chiffrement :\n    python3 -m pip install cryptography")
    env = lire_env()
    boutique = env.get("SHOPIFY_STORE", "").replace("https://", "").strip("/")
    if not boutique:
        sys.exit("Renseigne SHOPIFY_STORE=ma-boutique.myshopify.com dans .env")
    version = env.get("SHOPIFY_API_VERSION", "2026-07")
    depuis = sys.argv[1] if len(sys.argv) > 1 else env.get("SHOPIFY_SYNC_SINCE") or f"{dt.date.today().year - 1}-01-01"
    NOMS_TEST[:] = [nom_simple(n) for n in env.get("SHOPIFY_TEST_NAMES", "").split(",") if n.strip()]

    token = obtenir_token(env, boutique)
    print("✅ Connexion à Shopify réussie.")

    mot_de_passe = os.environ.get("DASHBOARD_PASSWORD") or getpass.getpass(
        "Mot de passe du dashboard (pour chiffrer les données) : "
    )
    if len(mot_de_passe) < 8:
        sys.exit("Mot de passe trop court (8 caractères minimum).")
    if os.environ.get("DASHBOARD_PASSWORD") and len(mot_de_passe) < 12:
        print("⚠️  Site en ligne : utilise un mot de passe d'au moins 12 caractères pour bien protéger data.js.")
    url = f"https://{boutique}/admin/api/{version}/graphql.json"
    entetes = {"X-Shopify-Access-Token": token}

    avec_frais = True
    commandes, curseur = [], None
    while True:
        requete = REQUETE.replace("%TRANSACTIONS%", TRANSACTIONS if avec_frais else "")
        rep = post_json(url, {"query": requete, "variables": {"curseur": curseur, "filtre": f"created_at:>={depuis}"}}, entetes)
        if rep.get("errors"):
            erreurs = json.dumps(rep["errors"], ensure_ascii=False)
            if "ACCESS_DENIED" in erreurs and '"orders"' in erreurs:
                sys.exit(
                    "❌ L'application n'a pas le droit de lire les commandes.\n"
                    "Dev Dashboard → ton application → Versions : ajoute les accès read_orders et read_all_orders,\n"
                    "publie la nouvelle version (Release), puis va dans Home et accepte la mise à jour\n"
                    "des autorisations sur ta boutique. Relance ensuite la synchro."
                )
            if avec_frais:
                print("ℹ️  Frais de paiement indisponibles avec ces droits, on continue sans.")
                avec_frais = False
                commandes, curseur = [], None
                continue
            sys.exit(f"Erreur GraphQL : {json.dumps(rep['errors'], ensure_ascii=False)[:800]}")
        page = rep["data"]["orders"]
        commandes += [normaliser(o, avec_frais) for o in page["nodes"]]
        print(f"  {len(commandes)} commandes récupérées…")
        if not page["pageInfo"]["hasNextPage"]:
            break
        curseur = page["pageInfo"]["endCursor"]

    donnees = {"syncedAt": dt.datetime.now().isoformat(timespec="seconds"), "depuis": depuis, "orders": commandes}
    (ICI / "data.js").write_text(
        "window.SHOPIFY_DATA_ENC = " + json.dumps(chiffrer(donnees, mot_de_passe)) + ";\n", encoding="utf-8"
    )
    print(f"✅ {len(commandes)} commandes depuis le {depuis} chiffrées dans data.js — recharge le dashboard.")


if __name__ == "__main__":
    main()
