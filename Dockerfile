FROM node:24-alpine
WORKDIR /app
COPY package.json ./
COPY server ./server
COPY dist ./dist
RUN mkdir -p /app/data && chown -R node:node /app
USER node
ENV HOST=0.0.0.0 PORT=4173 DATABASE_PATH=/app/data/snapday.sqlite
EXPOSE 4173
VOLUME ["/app/data"]
CMD ["node", "server/node.mjs"]
