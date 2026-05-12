FROM node:20-slim

# Install dependencies for Playwright (if needed for reCAPTCHA later)
RUN apt-get update && apt-get install -y \
    libgbm-dev \
    libnss3 \
    libasound2 \
    libatk-bridge2.0-0 \
    libgtk-3-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

# HF Spaces use port 7860
ENV PORT=7860
EXPOSE 7860

CMD ["node", "server.mjs"]
