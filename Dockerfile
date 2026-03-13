FROM node:20-slim

# Instalar dependencias del sistema: Tesseract OCR + Poppler + LibreOffice
RUN apt-get update && apt-get install -y \
    tesseract-ocr \
    tesseract-ocr-spa \
    poppler-utils \
    libreoffice \
    libreoffice-writer \
    fonts-liberation \
    --no-install-recommends \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Instalar dependencias Node primero (cache layer)
COPY package.json ./
RUN npm install --production

# Copiar código y template
COPY . .

# Crear directorios de trabajo
RUN mkdir -p uploads outputs

EXPOSE 3000

CMD ["node", "server.js"]
