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
  // EXP NRO: 4 a 6 dígitos / 4 dígitos año
  const expMatch = texto.match(/(\d{4,6}\/\d{4})/);
  const expNro   = expMatch ? expMatch[1] : null;

  let caratula = null;

  // Patrón A: formato estándar "caratulado: «...» que se tramita"
  const mA = texto.match(/caratulado:\s*\u201c([\s\S]+?)\u201d\s*que se tramita/);
  if (mA) caratula = mA[1].replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();

  // Patrón B: comillas rectas
  if (!caratula) {
    const mB = texto.match(/caratulado:\s*"([\s\S]+?)"\s*que se tramita/);
    if (mB) caratula = mB[1].replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
  }

  // Patrón C: carátula en negrita al inicio sin frase introductoria
  // "NOTIF. NEGATIVA\nFRANZESE, ..." → hasta comilla de cierre U+201D
  if (!caratula) {
    const mC = texto.match(/NOTIF[.\s]+NEGATIVA\s*\n([\s\S]+?)\u201d\s*que se tramita/);
    if (mC) caratula = mC[1].replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
  }

  // Patrón D: igual pero con comilla recta de cierre
  if (!caratula) {
    const mD = texto.match(/NOTIF[.\s]+NEGATIVA\s*\n([\s\S]+?)"\s*que se tramita/);
    if (mD) caratula = mD[1].replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
  }

  return { expNro, caratula };
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
  if (!fs.existsSync(pdfOut)) throw new Error('LibreOffice no generó el PDF.');
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
  // 1. OCR
  const texto = await extraerTextoPDF(pdfPath);
  const { expNro, caratula } = extraerDatosCedula(texto);

  if (!expNro || !caratula) {
    throw new Error(
      `No se pudieron extraer los datos del PDF. ` +
      `EXP NRO: ${expNro || 'no encontrado'} ` +
      `Carátula: ${caratula || 'no encontrada'}`
    );
  }

  const insercion = `${expNro} ${caratula}`;

  // 2. Generar DOCX con datos insertados
  const docxPath = path.join(workDir, 'acredita.docx');
  await generarDocx(templatePath, insercion, docxPath);

  // 3. Convertir DOCX → PDF (la nota)
  const notaPdfPath = convertirDocxAPdf(docxPath, workDir);

  // 4. Unir: nota + cédula original
  const pdfFinalPath = path.join(workDir, 'acredita_final.pdf');
  unirPDFs(notaPdfPath, pdfPath, pdfFinalPath);

  return { expNro, caratula, pdfPath: pdfFinalPath };
}

module.exports = { procesarCedula };
