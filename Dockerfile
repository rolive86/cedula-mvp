FROM node:20-slim

RUN apt-get update && apt-get install -y \
    tesseract-ocr \
    tesseract-ocr-spa \
    poppler-utils \
    libreoffice \
    libreoffice-writer \
    fonts-liberation \
    unzip \
    zip \
    --no-install-recommends \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY . .

RUN mkdir -p uploads outputs

EXPOSE 3000

CMD ["node", "server.js"]
