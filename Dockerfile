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
    chromium \
    chromium-driver \
    --no-install-recommends \
    && npx playwright install-deps chromium 2>/dev/null || true \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --production && npx playwright install chromium

COPY . .

RUN mkdir -p uploads outputs

EXPOSE 3000

CMD ["node", "server.js"]
