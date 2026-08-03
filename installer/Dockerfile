# ---- Stage 1: Build ----
FROM python:3.11-slim-bookworm AS builder

WORKDIR /app

# Install build dependencies
RUN apt-get update -qq && \
    apt-get install -y -qq --no-install-recommends \
        binutils \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install PyInstaller
RUN pip install --no-cache-dir pyinstaller>=6.0.0

# Copy build system and quorum_core
COPY build/ build/
COPY quorum_core/ quorum_core/

# Download and bundle llama-server (build-time only)
RUN if [ -f "build/bundle_binaries.py" ]; then \
        python build/bundle_binaries.py --download --output-dir build/; \
    fi

# Build the executable
RUN python build/build_exe.py --no-clean

# ---- Stage 2: Runtime ----
FROM debian:bookworm-slim

LABEL org.opencontainers.image.title="Quorum"
LABEL org.opencontainers.image.description="Quorum — AI Model Router & Orchestration Engine"
LABEL org.opencontainers.image.source="https://github.com/quorum/Quorum"
LABEL org.opencontainers.image.licenses="MIT"

# Install runtime dependencies
RUN apt-get update -qq && \
    apt-get install -y -qq --no-install-recommends \
        ca-certificates \
        libstdc++6 \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user
RUN useradd --create-home --shell /bin/bash quorum

# Copy the built executable from builder stage
COPY --from=builder /app/dist/Quorum /usr/local/bin/quorum

# Set up working directory
WORKDIR /home/quorum
RUN mkdir -p /home/quorum/.quorum && \
    chown -R quorum:quorum /home/quorum

USER quorum

# Expose default quorum API port
EXPOSE 8080

# Runtime config via environment
ENV QUORUM_BASE_URL=http://0.0.0.0:8080
ENV QUORUM_QUORUM_SIZE=3

ENTRYPOINT ["quorum"]
CMD ["--help"]
