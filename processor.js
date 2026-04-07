'use strict';

const fs             = require('fs');
const path           = require('path');
const os             = require('os');
const { execSync }   = require('child_process');
const tesseract      = require('node-tesseract-ocr');

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

function extraerDatosCedula(texto) {
  let expNro = null;

  // Patron 1: formato limpio 53577/2024
  const m1 = texto.match(/(\d{4,6}\/\d{4})/);
  if (m1) expNro = m1[1];

  // Patron 2: con espacio antes o despues de la barra
  if (!expNro) {
    const m2 = texto.match(/(\d{4,6})\s*\/\s*(\d{4})/);
    if (m2) expNro = `${m2[1]}/${m2[2]}`;
  }

  // Patron 3: digitos separados por espacios "5 3 5 7 7/2024"
  if (!expNro) {
    const m3 = texto.match(/([\d\s]{6,15})\/(\d{4})/);
    if (m3) {
      const num = m3[1].replace(/\s/g, '');
      if (num.length >= 4 && num.length <= 6) expNro = `${num}/${m3[2]}`;
    }
  }

  // Patron 4: buscar en la zona de la tabla cerca de CIVIL/FUERO
  if (!expNro) {
    const zonaTabla = texto.match(/[\s\S]{0,300}(?:CIVIL|FUERO)[\s\S]{0,300}/);
    if (zonaTabla) {
      const m4 = zonaTabla[0].match(/(\d{4,6})\s*\/\s*(\d{4})/);
      if (m4) expNro = `${m4[1]}/${m4[2]}`;
    }
  }

  let caratula = null;

  const mA = texto.match(/caratulado:\s*\u201c([\s\S]+?)\u201d\s*que se tramita/);
  if (mA) caratula = mA[1].replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();

  if (!caratula) {
    const mB = texto.match(/caratulado:\s*"([\s\S]+?)"\s*que se tramita/);
    if (mB) caratula = mB[1].replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
  }

  if (!caratula) {
    const mC = texto.match(/NOTIF[.\s]+NEGATIVA\s*\n([\s\S]+?)\u201d\s*que se tramita/);
    if (mC) caratula = mC[1].replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
  }

  if (!caratula) {
    const mD = texto.match(/NOTIF[.\s]+NEGATIVA\s*\n([\s\S]+?)"\s*que se tramita/);
    if (mD) caratula = mD[1].replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
  }

  return { expNro, caratula };
}

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

function convertirDocxAPdf(docxPath, outputDir) {
  execSync(
    `libreoffice --headless --convert-to pdf --outdir "${outputDir}" "${docxPath}"`,
    { env: { ...process.env, HOME: os.tmpdir() } }
  );
  const pdfOut = path.join(outputDir, path.basename(docxPath, '.docx') + '.pdf');
  if (!fs.existsSync(pdfOut)) throw new Error('LibreOffice no genero el PDF.');
  return pdfOut;
}

function unirPDFs(pdf1, pdf2, outputPath) {
  execSync(`pdfunite "${pdf1}" "${pdf2}" "${outputPath}"`);
  if (!fs.existsSync(outputPath)) throw new Error('No se pudo unir los PDFs.');
  return outputPath;
}

async function procesarCedula(pdfPath, workDir, templatePath) {
  const texto = await extraerTextoPDF(pdfPath);
  const { expNro, caratula } = extraerDatosCedula(texto);

  if (!expNro || !caratula) {
    throw new Error(
      `No se pudieron extraer los datos del PDF. ` +
      `EXP NRO: ${expNro || 'no encontrado'} ` +
      `Caratula: ${caratula || 'no encontrada'}`
    );
  }

  const insercion = `${expNro} ${caratula}`;
  const docxPath = path.join(workDir, 'acredita.docx');
  await generarDocx(templatePath, insercion, docxPath);
  const notaPdfPath = convertirDocxAPdf(docxPath, workDir);
  const pdfFinalPath = path.join(workDir, 'acredita_final.pdf');
  unirPDFs(notaPdfPath, pdfPath, pdfFinalPath);

  return { expNro, caratula, pdfPath: pdfFinalPath };
}

module.exports = { procesarCedula };
