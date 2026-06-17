FROM node:20-bookworm

WORKDIR /app

# System dependencies for Python + Playwright Chromium
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    chromium \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY requirements.txt ./
RUN python3 -m pip install --break-system-packages --no-cache-dir -r requirements.txt
RUN python3 -m playwright install --with-deps

COPY . .

RUN npx prisma generate
RUN npm run build
RUN chmod +x ./docker-start.sh

ENV NODE_ENV=production
ENV PYTHON_BIN=python3
ENV BROWSER_EXECUTABLE_PATH=/usr/bin/chromium

EXPOSE 3000

CMD ["./docker-start.sh"]
