# Dockerfile (v2.3.20)
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
RUN npm install --production
COPY server.js ./
COPY src ./src
COPY public ./public
RUN mkdir -p /app/data
VOLUME ["/app/data"]
ENV PORT=3000
EXPOSE 3000
CMD ["npm","start"]
