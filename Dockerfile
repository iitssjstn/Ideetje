FROM node:22-alpine
WORKDIR /app
COPY server.js ./
COPY public ./public
COPY admin ./admin
RUN mkdir -p /app/data && chown node:node /app/data
ENV NODE_ENV=production PORT=3000
USER node
VOLUME /app/data
EXPOSE 3000
CMD ["node", "server.js"]
