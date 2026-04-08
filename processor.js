'use strict';

const fs           = require('fs');
const path         = require('path');
const os           = require('os');
const { execSync } = require('child_process');
const tesseract    = require('node-tesseract-ocr');
const https        = require('https');

// ─────────────────────────────────────────────
// 1. OCR — extrae SOLO el EXP NRO del PDF
// ─────────────────────────────────────────────
async function extraerTextoPDF(pdfPath) {
  try {
    const texto = execSync(`pdftotext -layout "${pdfPath}" -`, { encoding: 'utf8' });
    if (texto.replace(/\s/g, '').length > 50) return texto;
  } catch (_) {}

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-'));
  try {
    execSync(`pdftoppm -r 300 -png "${pdfPath}" "${path.join(tmpDir, 'p')}"`);
    // Solo procesar la primera página — el EXP NRO siempre está ahí
    const imgs = fs.readdirSync(tmpDir).filter(f => f.endsWith('.png')).sort()
                   .map(f => path.join(tmpDir, f));

    // Procesar página por página hasta encontrar el EXP NRO
    let textoAcumulado = '';
    for (const img of imgs) {
      const textoPagina = await tesseract.recognize(img, { lang: 'spa', oem: 1, psm: 6 });
      textoAcumulado += textoPagina + '\n';
      if (extraerExpNro(textoAcumulado)) break;
    }
    return textoAcumulado;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function extraerExpNro(texto) {
  // Patron 1: formato limpio 53577/2024
  const m1 = texto.match(/(\d{4,6}\/\d{4})/);
  if (m1) return m1[1];

  // Patron 2: con espacio alrededor de la barra
  const m2 = texto.match(/(\d{4,6})\s*\/\s*(\d{4})/);
  if (m2) return `${m2[1]}/${m2[2]}`;

  // Patron 3: digitos separados por espacios "5 3 5 7 7/2024"
  const m3 = texto.match(/([\d\s]{6,15})\/(\d{4})/);
  if (m3) {
    const num = m3[1].replace(/\s/g, '');
    if (num.length >= 4 && num.length <= 6) return `${num}/${m3[2]}`;
  }

  // Patron 4: buscar en zona de tabla cerca de CIVIL/FUERO
  const zonaTabla = texto.match(/[\s\S]{0,300}(?:CIVIL|FUERO)[\s\S]{0,300}/);
  if (zonaTabla) {
    const m4 = zonaTabla[0].match(/(\d{4,6})\s*\/\s*(\d{4})/);
    if (m4) return `${m4[1]}/${m4[2]}`;
  }

  return null;
}

// ─────────────────────────────────────────────
// 2. Buscar datos en pjn_favoritos via Supabase
// ─────────────────────────────────────────────
async function buscarEnFavoritos(numero, anio) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    console.warn('[processor] SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY no configuradas');
    return null;
  }

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
          if (Array.isArray(rows) && rows.length > 0) {
            resolve(rows[0]);
          } else {
            resolve(null);
          }
        } catch (_) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(8000, () => { req.destroy(); resolve(null); });
  });
}

// ─────────────────────────────────────────────
// 3. Generar DOCX reemplazando marcador en XML
// ─────────────────────────────────────────────
async function generarDocx(templatePath, insercion, outputPath) {
  const tmpDir   = fs.mkdtempSync(path.join(os.tmpdir(), 'docx-'));
  const unzipDir = path.join(tmpDir, 'u');
  fs.mkdirSync(unzipDir);
  try {
    execSync(`cd "${unzipDir}" && unzip -q "${path.resolve(templatePath)}"`);
    const xmlPath = path.join(unzipDir, 'word', 'document.xml');
    let xml = fs.readFileSync(xmlPath, 'utf8');
    const MARCADOR = 'INSERTAR LOS DATOS EXTRAIDOS DE LA CEDULA';
    if (!xml.includes(MARCADOR)) throw new Error('Marcador no encontrado en el template.');
    xml = xml.replace(MARCADOR, insercion);
    fs.writeFileSync(xmlPath, xml, 'utf8');
    execSync(`cd "${unzipDir}" && zip -qr "${path.resolve(outputPath)}" .`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ─────────────────────────────────────────────
// 4. Convertir DOCX → PDF con LibreOffice
// ─────────────────────────────────────────────
function convertirDocxAPdf(docxPath, outputDir) {
  execSync(
    `libreoffice --headless --convert-to pdf --outdir "${outputDir}" "${docxPath}"`,
    { env: { ...process.env, HOME: os.tmpdir() } }
  );
  const pdfOut = path.join(outputDir, path.basename(docxPath, '.docx') + '.pdf');
  if (!fs.existsSync(pdfOut)) throw new Error('LibreOffice no genero el PDF.');
  return pdfOut;
}

// ─────────────────────────────────────────────
// 5. Unir dos PDFs con pdfunite (poppler)
// ─────────────────────────────────────────────
function unirPDFs(pdf1, pdf2, outputPath) {
  execSync(`pdfunite "${pdf1}" "${pdf2}" "${outputPath}"`);
  if (!fs.existsSync(outputPath)) throw new Error('No se pudo unir los PDFs.');
  return outputPath;
}

// ─────────────────────────────────────────────
// PIPELINE COMPLETO
// ─────────────────────────────────────────────
async function procesarCedula(pdfPath, workDir, templatePath) {
  // 1. OCR — solo para extraer EXP NRO
  const texto = await extraerTextoPDF(pdfPath);
  const expNro = extraerExpNro(texto);

  if (!expNro) {
    throw new Error('No se pudo extraer el número de expediente del PDF.');
  }

  // 2. Parsear número y año
  const [numero, anioStr] = expNro.split('/');
  const anio = parseInt(anioStr, 10);

  console.log(`[processor] EXP NRO extraído: ${expNro}`);

  // 3. Buscar carátula en pjn_favoritos
  // Intentar con el número tal cual, y también con cero adelante (ej: 23812 → 023812)
  let caratula = null;
  let favorito = await buscarEnFavoritos(numero, anio);
  if (!favorito) {
    // Probar con cero adelante
    favorito = await buscarEnFavoritos('0' + numero, anio);
  }
  if (!favorito) {
    // Probar sin ceros adelante (por si el OCR agregó uno)
    favorito = await buscarEnFavoritos(numero.replace(/^0+/, ''), anio);
  }

  if (favorito?.caratula) {
    caratula = favorito.caratula;
    console.log(`[processor] Carátula desde pjn_favoritos: ${caratula.substring(0, 60)}`);
  } else {
    // Fallback: intentar extraer del OCR si no está en favoritos
    console.warn(`[processor] ${expNro} no está en pjn_favoritos, intentando OCR de carátula`);
    const mA = texto.match(/caratulado:\s*\u201c([\s\S]+?)\u201d\s*que se tramita/);
    if (mA) caratula = mA[1].replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();

    if (!caratula) {
      const mB = texto.match(/caratulado:\s*"([\s\S]+?)"\s*que se tramita/);
      if (mB) caratula = mB[1].replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
    }

    if (!caratula) {
      throw new Error(
        `EXP NRO: ${expNro} no encontrado en pjn_favoritos y no se pudo extraer la carátula del PDF.`
      );
    }
  }

  const insercion = `${expNro} ${caratula}`;

  // 4. Generar DOCX
  const docxPath = path.join(workDir, 'acredita.docx');
  await generarDocx(templatePath, insercion, docxPath);

  // 5. Convertir a PDF
  const notaPdfPath = convertirDocxAPdf(docxPath, workDir);

  // 6. Unir nota + cédula original
  const pdfFinalPath = path.join(workDir, 'acredita_final.pdf');
  unirPDFs(notaPdfPath, pdfPath, pdfFinalPath);

  return { expNro, caratula, pdfPath: pdfFinalPath };
}

module.exports = { procesarCedula };
