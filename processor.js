'use strict';

const fs             = require('fs');
const path           = require('path');
const os             = require('os');
const { execSync }   = require('child_process');
const tesseract      = require('node-tesseract-ocr');

// ─────────────────────────────────────────────
// 1. OCR / extracción de texto del PDF
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
    const textos = await Promise.all(
      imgs.map(img => tesseract.recognize(img, { lang: 'spa', oem: 1, psm: 6 }))
    );
    return textos.join('\n');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ─────────────────────────────────────────────
// 2. Parsear EXP NRO y carátula
// ─────────────────────────────────────────────
function extraerDatosCedula(texto) {
  const expMatch = texto.match(/(\d{6}\/\d{4})/);
  const expNro   = expMatch ? expMatch[1] : null;

  let caratula = null;
  // Anchored: comillas tipográficas U+201C/U+201D después de "caratulado:"
  const m1 = texto.match(/caratulado:\s*\u201c([\s\S]+?)\u201d\s*que se tramita/);
  if (m1) caratula = m1[1].replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
  // Fallback: comillas rectas
  if (!caratula) {
    const m2 = texto.match(/caratulado:\s*"([\s\S]+?)"\s*que se tramita/);
    if (m2) caratula = m2[1].replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
  }

  return { expNro, caratula };
}

// ─────────────────────────────────────────────
// 3. Generar DOCX reemplazando marcador en XML
// ─────────────────────────────────────────────
async function generarDocx(templatePath, insercion, outputPath) {
  const tmpDir    = fs.mkdtempSync(path.join(os.tmpdir(), 'docx-'));
  const unzipDir  = path.join(tmpDir, 'u');
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
  const base   = path.basename(docxPath, '.docx');
  const pdfOut = path.join(outputDir, `${base}.pdf`);
  if (!fs.existsSync(pdfOut)) throw new Error('LibreOffice no generó el PDF.');
  return pdfOut;
}

// ─────────────────────────────────────────────
// PIPELINE COMPLETO
// ─────────────────────────────────────────────
async function procesarCedula(pdfPath, workDir, templatePath) {
  // OCR
  const texto = await extraerTextoPDF(pdfPath);
  const { expNro, caratula } = extraerDatosCedula(texto);

  if (!expNro || !caratula) {
    throw new Error(
      `No se pudieron extraer los datos del PDF.\n` +
      `EXP NRO: ${expNro || 'no encontrado'}\n` +
      `Carátula: ${caratula || 'no encontrada'}`
    );
  }

  const insercion = `${expNro} ${caratula}`;

  // Generar DOCX
  const docxPath = path.join(workDir, 'acredita.docx');
  await generarDocx(templatePath, insercion, docxPath);

  // Convertir a PDF
  const pdfResultPath = convertirDocxAPdf(docxPath, workDir);

  return { expNro, caratula, pdfPath: pdfResultPath };
}

module.exports = { procesarCedula };
