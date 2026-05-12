FROM mcr.microsoft.com/playwright:v1.60.0-jammy

# Install xvfb for virtual display support
RUN apt-get update && apt-get install -y xvfb && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm install

# Copy the rest of the application
COPY . .

# HF Spaces use port 7860
ENV PORT=7860
EXPOSE 7860

# Run the server using xvfb-run to support headed browser mode in Docker
CMD ["xvfb-run", "--server-args=-screen 0 1280x720x24", "node", "server.mjs"]
