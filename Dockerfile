# ── Stage 1: Build ────────────────────────────────────────────────────────────
FROM golang:1.23-alpine AS builder

WORKDIR /build
COPY go.mod go.sum ./
RUN go mod download

COPY main.go .
ARG VERSION=v1.3.0
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w -X main.version=${VERSION}" -o markdown-notes .

# ── Stage 2: Run ──────────────────────────────────────────────────────────────
FROM alpine:3.20

RUN addgroup -S app && adduser -S app -G app
WORKDIR /app

# Copy binary and static assets
COPY --from=builder /build/markdown-notes .
COPY static/ ./static/

# notes/ is intentionally excluded — mount it as a volume so data persists
RUN chown -R app:app /app
USER app

EXPOSE 8080
CMD ["./markdown-notes"]
