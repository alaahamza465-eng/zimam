FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY main.js ./
COPY public ./public
ENV NODE_ENV=production PORT=3030 DATA_DIR=/data
EXPOSE 3030
CMD ["node", "main.js"]
