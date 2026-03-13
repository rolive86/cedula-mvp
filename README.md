# Acredita Diligenciamiento — MVP

Procesa cédulas judiciales escaneadas (PDF) y genera automáticamente el escrito "Acredita Diligenciamiento" en PDF, listo para presentar.

## Stack
- **Backend**: Node.js + Express
- **OCR**: Tesseract (español)
- **PDF → imagen**: Poppler (pdftoppm)
- **DOCX → PDF**: LibreOffice headless
- **Deploy**: Railway con Docker

---

## Deploy en Railway (5 minutos)

### 1. Requisitos previos
- Cuenta en [railway.app](https://railway.app)
- Git instalado
- Railway CLI (opcional): `npm install -g @railway/cli`

### 2. Subir el template
Asegurate de que el archivo `acredita_diligenciamiento.docx` esté en la raíz del proyecto (al lado de `server.js`).

### 3. Deploy

**Opción A — Desde GitHub (recomendado):**
```bash
git init
git add .
git commit -m "first commit"
# Crear repo en GitHub y pushearlo
# En Railway: New Project → Deploy from GitHub → seleccionar repo
```

**Opción B — Railway CLI:**
```bash
railway login
railway init
railway up
```

Railway detecta el `Dockerfile` automáticamente y hace todo solo.

### 4. Variables de entorno (no son necesarias por defecto)
Railway asigna `PORT` automáticamente. La app lo lee con `process.env.PORT || 3000`.

---

## Estructura del proyecto

```
cedula-mvp/
├── Dockerfile                      ← imagen Docker con Tesseract + LibreOffice
├── package.json
├── server.js                       ← servidor Express
├── processor.js                    ← OCR + extracción + generación DOCX/PDF
├── acredita_diligenciamiento.docx  ← template (NO modificar el marcador)
└── public/
    └── index.html                  ← frontend
```

---

## Cómo funciona

1. Usuario sube la cédula PDF escaneada
2. `pdftoppm` convierte cada página a imagen PNG (300 DPI)
3. Tesseract OCR extrae el texto en español
4. Regex extrae `EXP NRO` (formato `000000/YYYY`) y la carátula (entre comillas tipográficas después de "caratulado:")
5. Se reemplaza el marcador en el XML del DOCX template: `INSERTAR LOS DATOS EXTRAIDOS DE LA CEDULA`
6. LibreOffice convierte el DOCX resultante a PDF
7. El PDF se devuelve al usuario como descarga

---

## Desarrollo local

```bash
# Instalar dependencias del sistema (Ubuntu/Debian)
sudo apt install tesseract-ocr tesseract-ocr-spa poppler-utils libreoffice

# Instalar dependencias Node
npm install

# Correr
node server.js
# → http://localhost:3000
```

---

## Modificar el template

El único requisito es que el DOCX tenga exactamente este texto como marcador:
```
INSERTAR LOS DATOS EXTRAIDOS DE LA CEDULA
```
(sin comillas, sin formato especial — el texto plano en el XML)

El sistema lo reemplaza por: `005260/2022 ROJO GOMES, EVELYN ROCIO C/ DAHER...`
