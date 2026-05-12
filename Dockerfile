FROM mcr.microsoft.com/playwright:v1.43.1-jammy

WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm install

# Copy the rest of the application
COPY . .

# HF Spaces use port 7860
ENV PORT=7860
EXPOSE 7860

# Run the server
CMD ["node", "server.mjs"]
