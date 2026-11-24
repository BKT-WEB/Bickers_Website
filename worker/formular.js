// Bickers Website – Formular-Versand über Cloudflare Email Routing
//
// Die Website schickt jedes Formular per POST an /api/formular.
// Dieser Worker prüft die Daten, legt den Empfänger HIER fest (nicht im Browser,
// damit niemand das Formular als Spam-Schleuder für beliebige Adressen nutzen kann)
// und verschickt die Anfrage als E-Mail mit Anhängen.
// Alle anderen Adressen (index.html, Bilder, PDFs) liefert Cloudflare direkt aus.

import { EmailMessage } from "cloudflare:email";

// ---------------------------------------------------------------------------
// Einstellungen
// ---------------------------------------------------------------------------

// Absender: Adresse auf der Domain, für die Cloudflare Email Routing aktiv ist.
const ABSENDER = "website@formular.bickers.de";
const ABSENDER_NAME = "Bickers Website";

// Empfänger je Formular. Jede Adresse muss in Cloudflare unter
// Email Routing → Zieladressen bestätigt sein UND in wrangler.jsonc stehen.
const EMPFAENGER = {
  kontakt: "sales@bickers.de",
  angebot: "sales@bickers.de",
  angebotPlotter: "sales@gluejet.com", // Angebote für GLUEJET / TAPEJET
  showroom: "sales@gluejet.com",
  bewerbung: "info@bickers.de",
};

// Kontaktformular: Empfänger je gewähltem Anliegen (Feld "thema").
const KONTAKT_THEMEN = {
  "Klebstoffberatung": "sales@bickers.de",
  "Klebepistolen und Zubehör": "sales@bickers.de",
  "Industriemaschinen (GLUEJET / TAPEJET)": "sales@gluejet.com",
  "Ersatzteile und Reparaturen": "sales@bickers.de",
  "Bestellung und Lieferung": "sales@bickers.de",
  "Allgemeine Anfrage": "sales@bickers.de",
};

const FORMULAR_NAMEN = {
  kontakt: "Kontakt",
  angebot: "Angebotsanfrage",
  showroom: "Showroom-Anfrage",
  bewerbung: "Bewerbung",
};

const MAX_DATEI = 10 * 1024 * 1024; // 10 MB je Datei (wie im Formular angegeben)
const MAX_GESAMT = 10 * 1024 * 1024; // 10 MB alle Anhänge zusammen
const MAX_DATEIEN = 10;
const MAX_FELDER = 40;
const MAX_FELDLAENGE = 5000;
const ENDUNGEN = ["pdf", "jpg", "jpeg", "png", "webp", "dxf", "dwg", "doc", "docx", "xls", "xlsx", "zip"];

const FEHLER_ALLGEMEIN =
  "Ihre Nachricht konnte leider nicht gesendet werden. Bitte schreiben Sie uns direkt an sales@bickers.de.";

// Technische Felder, die nicht als normale Zeile in der E-Mail erscheinen
const INTERN = new Set(["formular", "website", "thema", "produkt", "betreff", "email"]);

// ---------------------------------------------------------------------------
// Einstiegspunkt
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/formular") {
      if (request.method !== "POST") {
        return antwort({ ok: false, fehler: "Nur POST erlaubt." }, 405);
      }
      // Nur Anfragen von der eigenen Website annehmen
      const origin = request.headers.get("Origin");
      if (origin && origin !== url.origin) {
        return antwort({ ok: false, fehler: "Nicht erlaubt." }, 403);
      }
      const laenge = Number(request.headers.get("Content-Length") || 0);
      if (laenge > MAX_GESAMT + 1024 * 1024) {
        return antwort({ ok: false, fehler: "Die Anhänge sind zusammen größer als 10 MB." }, 413);
      }
      try {
        return await formularSenden(request, env);
      } catch (e) {
        console.error("Formular-Versand fehlgeschlagen:", e && e.stack ? e.stack : e);
        return antwort({ ok: false, fehler: FEHLER_ALLGEMEIN }, 500);
      }
    }

    // Alles andere: statische Dateien der Website
    return env.ASSETS.fetch(request);
  },
};

// ---------------------------------------------------------------------------
// Formular verarbeiten
// ---------------------------------------------------------------------------

async function formularSenden(request, env) {
  const daten = await request.formData();

  // Honeypot: unsichtbares Feld "website". Menschen lassen es leer, Bots füllen es aus.
  // Bots bekommen eine Erfolgsmeldung, es wird aber nichts verschickt.
  if (textWert(daten.get("website")).trim() !== "") {
    return antwort({ ok: true });
  }

  const art = textWert(daten.get("formular"));
  if (!FORMULAR_NAMEN[art]) {
    return antwort({ ok: false, fehler: "Unbekanntes Formular." }, 400);
  }

  const thema = einzeilig(textWert(daten.get("thema")));
  const produkt = einzeilig(textWert(daten.get("produkt")));
  const empfaenger = empfaengerFuer(art, thema, produkt);

  const email = textWert(daten.get("email")).trim();
  if (email.length > 254 || !/^[^\s@<>"(),;:]+@[^\s@<>"(),;:]+\.[A-Za-z]{2,}$/.test(email)) {
    return antwort({ ok: false, fehler: "Bitte geben Sie eine gültige E-Mail-Adresse an." }, 400);
  }

  const betreff =
    einzeilig(textWert(daten.get("betreff"))).slice(0, 200) ||
    FORMULAR_NAMEN[art] + (produkt ? ": " + produkt : "");

  // Felder und Anhänge einsammeln
  const zeilen = [];
  const anhaenge = [];
  let anzahlFelder = 0;
  let gesamt = 0;

  for (const [name, wert] of daten.entries()) {
    if (typeof wert === "string") {
      if (INTERN.has(name)) continue;
      if (++anzahlFelder > MAX_FELDER) {
        return antwort({ ok: false, fehler: "Zu viele Felder." }, 400);
      }
      const inhalt = wert.trim().slice(0, MAX_FELDLAENGE);
      if (!inhalt) continue;
      const bezeichnung = einzeilig(name).slice(0, 60);
      zeilen.push(inhalt.includes("\n") ? `${bezeichnung}:\n${inhalt}\n` : `${bezeichnung}: ${inhalt}`);
      continue;
    }

    // Datei
    if (!wert || (!wert.name && !wert.size)) continue;
    if (anhaenge.length >= MAX_DATEIEN) {
      return antwort({ ok: false, fehler: `Bitte höchstens ${MAX_DATEIEN} Dateien anhängen.` }, 400);
    }
    const dateiName = sichererDateiname(wert.name);
    const endung = (dateiName.split(".").pop() || "").toLowerCase();
    if (!ENDUNGEN.includes(endung)) {
      return antwort({ ok: false, fehler: `Der Dateityp von „${dateiName}“ ist nicht erlaubt.` }, 400);
    }
    if (wert.size > MAX_DATEI) {
      return antwort({ ok: false, fehler: `„${dateiName}“ ist größer als 10 MB.` }, 413);
    }
    gesamt += wert.size;
    if (gesamt > MAX_GESAMT) {
      return antwort({ ok: false, fehler: "Die Anhänge sind zusammen größer als 10 MB." }, 413);
    }
    anhaenge.push({
      name: dateiName,
      typ: /^[\w.+-]+\/[\w.+-]+$/.test(wert.type || "") ? wert.type : "application/octet-stream",
      inhalt: new Uint8Array(await wert.arrayBuffer()),
    });
  }

  const zeit = new Date().toLocaleString("de-DE", { timeZone: "Europe/Berlin" });
  const regel =
    art === "kontakt" && thema ? `Anliegen „${thema}“` :
    art === "angebot" && produkt ? `Produkt „${produkt}“` :
    FORMULAR_NAMEN[art];

  const text = [
    `Neue Anfrage über die Website – Formular: ${FORMULAR_NAMEN[art]}`,
    `Eingegangen: ${zeit}`,
    `Zugeordnet nach: ${regel} → ${empfaenger}`,
    "",
    `E-Mail: ${email}`,
    thema ? `Anliegen: ${thema}` : null,
    produkt ? `Produkt: ${produkt}` : null,
    ...zeilen,
    "",
    anhaenge.length
      ? `Anhänge (${anhaenge.length}): ${anhaenge.map((a) => a.name).join(", ")}`
      : "Keine Anhänge.",
    "",
    "—",
    "Mit „Antworten“ schreiben Sie direkt an den Absender des Formulars.",
  ]
    .filter((z) => z !== null)
    .join("\n")
    .replace(/\r?\n/g, "\r\n");

  const roh = mimeNachricht({
    an: empfaenger,
    antwortAn: email,
    betreff,
    text,
    anhaenge,
  });

  await env.FORMULAR.send(new EmailMessage(ABSENDER, empfaenger, roh));
  return antwort({ ok: true });
}

function empfaengerFuer(art, thema, produkt) {
  if (art === "kontakt") return KONTAKT_THEMEN[thema] || EMPFAENGER.kontakt;
  if (art === "angebot") return /GLUEJET|TAPEJET/i.test(produkt) ? EMPFAENGER.angebotPlotter : EMPFAENGER.angebot;
  return EMPFAENGER[art];
}

// ---------------------------------------------------------------------------
// E-Mail zusammenbauen (MIME, UTF-8, Anhänge als Base64)
// ---------------------------------------------------------------------------

function mimeNachricht({ an, antwortAn, betreff, text, anhaenge }) {
  const grenze = "----=_Bickers_" + crypto.randomUUID();
  const domain = ABSENDER.split("@")[1];

  const kopf = [
    `From: ${kodiereKopf(ABSENDER_NAME)} <${ABSENDER}>`,
    `To: <${an}>`,
    `Reply-To: <${antwortAn}>`,
    `Subject: ${kodiereKopf(betreff)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@${domain}>`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${grenze}"`,
  ].join("\r\n");

  const teile = [
    `--${grenze}\r\n` +
      "Content-Type: text/plain; charset=utf-8\r\n" +
      "Content-Transfer-Encoding: base64\r\n\r\n" +
      base64Zeilen(new TextEncoder().encode(text)) +
      "\r\n",
  ];

  for (const a of anhaenge) {
    const ascii = a.name.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_");
    teile.push(
      `--${grenze}\r\n` +
        `Content-Type: ${a.typ}; name="${ascii}"\r\n` +
        `Content-Disposition: attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(a.name)}\r\n` +
        "Content-Transfer-Encoding: base64\r\n\r\n" +
        base64Zeilen(a.inhalt) +
        "\r\n"
    );
  }

  return kopf + "\r\n\r\n" + teile.join("") + `--${grenze}--\r\n`;
}

// Kopfzeilen mit Umlauten nach RFC 2047 kodieren (in Stücken, ohne Zeichen zu zerteilen)
function kodiereKopf(wert) {
  if (/^[\x20-\x7E]*$/.test(wert)) return wert;
  const stuecke = [];
  let aktuell = "";
  for (const zeichen of wert) {
    if (new TextEncoder().encode(aktuell + zeichen).length > 45) {
      stuecke.push(aktuell);
      aktuell = "";
    }
    aktuell += zeichen;
  }
  if (aktuell) stuecke.push(aktuell);
  return stuecke.map((s) => `=?UTF-8?B?${base64(new TextEncoder().encode(s))}?=`).join("\r\n ");
}

function base64(bytes) {
  let binaer = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binaer += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(binaer);
}

// Base64 mit Zeilenumbruch nach 76 Zeichen (vorgeschrieben für E-Mail)
function base64Zeilen(bytes) {
  return base64(bytes).replace(/.{76}/g, "$&\r\n");
}

// ---------------------------------------------------------------------------
// Hilfsfunktionen
// ---------------------------------------------------------------------------

function textWert(wert) {
  return typeof wert === "string" ? wert : "";
}

// Zeilenumbrüche und Steuerzeichen entfernen (verhindert manipulierte E-Mail-Kopfzeilen)
function einzeilig(wert) {
  return String(wert).replace(/[\x00-\x1F\x7F]+/g, " ").replace(/\s+/g, " ").trim();
}

function sichererDateiname(name) {
  const basis = String(name || "datei").split(/[\\/]/).pop();
  return einzeilig(basis).replace(/["<>|*?:]/g, "_").slice(0, 120) || "datei";
}

function antwort(objekt, status = 200) {
  return new Response(JSON.stringify(objekt), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}
