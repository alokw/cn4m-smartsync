FROM node:22-alpine

WORKDIR /app

# No runtime dependencies -- package.json is copied for metadata only.
COPY package.json ./
COPY src ./src

# Token + watermark state lives here; mount a volume so it survives restarts.
RUN mkdir -p /data
ENV DATA_DIR=/data
ENV PORT=2646

EXPOSE 2646

CMD ["node", "src/index.js"]
