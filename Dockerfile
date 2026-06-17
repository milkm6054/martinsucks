FROM node:20-bookworm

WORKDIR /app

# System dependencies for Python + Playwright Chromium
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY requirements.txt ./
RUN python3 -m pip install --break-system-packages --no-cache-dir -r requirements.txt
RUN python3 -m playwright install --with-deps chromium

COPY . .

RUN npx prisma generate
RUN npm run build

ENV NODE_ENV=production
ENV PYTHON_BIN=python3

EXPOSE 3000

CMD ["sh", "-c", "PORT=${PORT:-3000} npx prisma migrate deploy && PORT=${PORT:-3000} npm start"]
