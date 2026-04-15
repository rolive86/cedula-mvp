'use strict';

const fs           = require('fs');
const path         = require('path');
const os           = require('os');
const { execSync } = require('child_process');
const tesseract    = require('node-tesseract-ocr');
const https        = require('https');

// ─────────────────────────────────────────────
// 1. OCR — extrae texto del PDF
// ─────────────────────────────────────────────
async function extraerTextoPDF(pdfPath) {
  try {
    const texto = execSync(`pdftotext -layout "${pdfPath}" -`, { encoding: 'utf8' });
    if (texto.replace(/\s/g, '').length > 50) return texto;
  } catch (_) {}

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-'));
  try {
    execSync(`pdftoppm -r 300 -png "${pdfPath}" "${path.join(tmpDir, 'p')}"`);
    const imgs = fs.readdirSync(tmpDir).filter(f => f.endsWith('.png')).sort()
                   .map(f => path.join(tmpDir, f));

    let textoAcumulado = '';
    for (const img of imgs) {
      const textoPagina = await tesseract.recognize(img, { lang: 'spa', oem: 1, psm: 6 });
      textoAcumulado += textoPagina + '\n';
      if (extraerExpNro(textoAcumulado) && extraerDestinatario(textoAcumulado)) break;
    }
    return textoAcumulado;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ─────────────────────────────────────────────
// 2. Extraer EXP NRO
// ─────────────────────────────────────────────
function extraerExpNro(texto) {
  // Patron 1: expten° 54070/2025 o expte n° 54070/2025
  const m1 = texto.match(/expte?n?[°\s.]*\s*(\d{4,6}\/\d{4})/i);
  if (m1) return m1[1];

  // Patron 2: formato limpio 54070/2025
  const m2 = texto.match(/(\d{4,6}\/\d{4})/);
  if (m2) return m2[1];

  // Patron 3: con espacios alrededor de la barra
  const m3 = texto.match(/(\d{4,6})\s*\/\s*(\d{4})/);
  if (m3) return `${m3[1]}/${m3[2]}`;

  return null;
}

// ─────────────────────────────────────────────
// 3. Extraer destinatario del oficio
// ─────────────────────────────────────────────
function extraerDestinatario(texto) {
  // Patron A: "Al SR. DIRECTOR del\nHospital..."
  const mA = texto.match(/Al\s+SR[.\s]+DIRECTOR\s+del?\s*\n([^\n]+)/i);
  if (mA) return mA[1].trim();

  // Patron B: "Al SR. DIRECTOR de la\nClínica..."
  const mB = texto.match(/Al\s+SR[.\s]+DIRECTOR\s+de\s+la?\s*\n([^\n]+)/i);
  if (mB) return mB[1].trim();

  // Patron C: "Al\nHospital..."
  const mC = texto.match(/^Al\s*\n([^\n]+)/im);
  if (mC) return mC[1].trim();

  // Patron D: buscar linea que empiece con Hospital, Clínica, Municipalidad
  const mD = texto.match(/(Hospital|Cl[íi]nica|Municipalidad|Instituto|Sanatorio|Centro)[^\n]+/i);
  if (mD) return mD[0].trim();

  return null;
}

// ─────────────────────────────────────────────
// 4. Buscar carátula en pjn_favoritos
// ─────────────────────────────────────────────
async function buscarEnFavoritos(numero, anio) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseKey) return null;

  const url = `${supabaseUrl}/rest/v1/pjn_favoritos?numero=eq.${numero}&anio=eq.${anio}&select=caratula,jurisdiccion,juzgado&limit=1`;

  return new Promise((resolve) => {
    const req = https.get(url, {
      headers: {
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
        'Accept': 'application/json',
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const rows = JSON.parse(data);
          if (Array.isArray(rows) && rows.length > 0) resolve(rows[0]);
          else {
            // Intentar con cero adelante
            buscarConCero(numero, anio, supabaseUrl, supabaseKey).then(resolve);
          }
        } catch (_) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(8000, () => { req.destroy(); resolve(null); });
  });
}

async function buscarConCero(numero, anio, supabaseUrl, supabaseKey) {
  const url = `${supabaseUrl}/rest/v1/pjn_favoritos?numero=eq.0${numero}&anio=eq.${anio}&select=caratula,jurisdiccion,juzgado&limit=1`;
  return new Promise((resolve) => {
    const req = https.get(url, {
      headers: {
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
        'Accept': 'application/json',
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const rows = JSON.parse(data);
          resolve(Array.isArray(rows) && rows.length > 0 ? rows[0] : null);
        } catch (_) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(8000, () => { req.destroy(); resolve(null); });
  });
}

// ─────────────────────────────────────────────
// 5. Generar DOCX reemplazando marcadores
// ─────────────────────────────────────────────
async function generarDocx(templatePath, insercionExpCaratula, insercionDestinatario, outputPath) {
  const tmpDir   = fs.mkdtempSync(path.join(os.tmpdir(), 'docx-'));
  const unzipDir = path.join(tmpDir, 'u');
  fs.mkdirSync(unzipDir);
  try {
    execSync(`cd "${unzipDir}" && unzip -q "${path.resolve(templatePath)}"`);
    const xmlPath = path.join(unzipDir, 'word', 'document.xml');
    let xml = fs.readFileSync(xmlPath, 'utf8');

    const MARCADOR_DATOS    = 'INSERTAR LOS DATOS EXTRAIDOS DE LA CEDULA';
    const MARCADOR_DEST     = 'INSERTAR DESTINATARIO DEL OFICIO';

    if (!xml.includes(MARCADOR_DATOS)) throw new Error('Marcador de datos no encontrado en el template de oficio.');
    if (!xml.includes(MARCADOR_DEST))  throw new Error('Marcador de destinatario no encontrado en el template de oficio.');

    xml = xml.replace(MARCADOR_DATOS, insercionExpCaratula);
    xml = xml.replace(MARCADOR_DEST,  insercionDestinatario);

    fs.writeFileSync(xmlPath, xml, 'utf8');
    execSync(`cd "${unzipDir}" && zip -qr "${path.resolve(outputPath)}" .`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ─────────────────────────────────────────────
// 6. Convertir DOCX → PDF
// ─────────────────────────────────────────────
function convertirDocxAPdf(docxPath, outputDir) {
  execSync(
    `libreoffice --headless --convert-to pdf --outdir "${outputDir}" "${docxPath}"`,
    { env: { ...process.env, HOME: os.tmpdir() } }
  );
  const pdfOut = path.join(outputDir, path.basename(docxPath, '.docx') + '.pdf');
  if (!fs.existsSync(pdfOut)) throw new Error('LibreOffice no generó el PDF.');
  return pdfOut;
}

// ─────────────────────────────────────────────
// 7. Unir PDFs
// ─────────────────────────────────────────────
function unirPDFs(pdf1, pdf2, outputPath) {
  execSync(`pdfunite "${pdf1}" "${pdf2}" "${outputPath}"`);
  if (!fs.existsSync(outputPath)) throw new Error('No se pudo unir los PDFs.');
  return outputPath;
}

// ─────────────────────────────────────────────
// PIPELINE COMPLETO
// ─────────────────────────────────────────────
async function procesarOficio(pdfPath, workDir, templatePath) {
  // 1. OCR
  const texto = await extraerTextoPDF(pdfPath);

  // 2. Extraer datos
  const expNro       = extraerExpNro(texto);
  const destinatario = extraerDestinatario(texto);

  console.log('[Oficio] expNro:', expNro);
  console.log('[Oficio] destinatario:', destinatario);

  if (!expNro) {
    throw new Error(`No se pudo extraer el número de expediente del oficio.`);
  }

  // 3. Buscar carátula en pjn_favoritos
  const [numero, anioStr] = expNro.split('/');
  const anio = parseInt(anioStr, 10);

  let caratula = null;
  const favorito = await buscarEnFavoritos(numero, anio);
  if (favorito?.caratula) {
    caratula = favorito.caratula;
    console.log('[Oficio] Carátula desde pjn_favoritos:', caratula.substring(0, 60));
  } else {
    // Fallback: extraer carátula del texto del oficio
    const mCar = texto.match(/autos\s+caratulados\s+como\s+"([^"]+)"/i) ||
                 texto.match(/expten?[°\s.]*\s*\d{4,6}\/\d{4}\s+(?:en\s+autos\s+)?(?:caratulados\s+como\s+)?"([^"]+)"/i);
    if (mCar) caratula = mCar[1].replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
  }

  if (!caratula) {
    throw new Error(`expNro: ${expNro} no encontrado en pjn_favoritos y no se pudo extraer la carátula.`);
  }

  if (!destinatario) {
    throw new Error(`No se pudo extraer el destinatario del oficio.`);
  }

  // 4. Armar textos de inserción
  const insercionExpCaratula = `${expNro} ${caratula}`;
  const insercionDestinatario = destinatario;

  // 5. Generar DOCX
  const docxPath = path.join(workDir, 'acredita_oficio.docx');
  await generarDocx(templatePath, insercionExpCaratula, insercionDestinatario, docxPath);

  // 6. Convertir a PDF
  const notaPdfPath = convertirDocxAPdf(docxPath, workDir);

  // 7. Unir nota + oficio original
  const pdfFinalPath = path.join(workDir, 'acredita_oficio_final.pdf');
  unirPDFs(notaPdfPath, pdfPath, pdfFinalPath);

  return { expNro, caratula, destinatario, pdfPath: pdfFinalPath };
}

module.exports = { procesarOficio };
