group "default" {
  targets = ["api", "notifications"]
}

target "api" {
  context    = "."
  dockerfile = "apps/api/Dockerfile"
  target     = "production"
  platforms  = [
    "linux/amd64",
    "linux/arm64"
  ]
  tags = [
    "ghcr.io/kyvera-labs/verixa-api:latest"
  ]
  labels = {
    "org.opencontainers.image.title"       = "verixa-api"
    "org.opencontainers.image.description" = "Verixa API Gateway and Auth Service"
    "org.opencontainers.image.source"      = "https://github.com/Kyvera-Labs/verixa"
  }
}

target "notifications" {
  context    = "."
  dockerfile = "packages/notifications/Dockerfile"
  target     = "production"
  platforms  = [
    "linux/amd64",
    "linux/arm64"
  ]
  tags = [
    "ghcr.io/kyvera-labs/verixa-notifications:latest"
  ]
  labels = {
    "org.opencontainers.image.title"       = "verixa-notifications"
    "org.opencontainers.image.description" = "Verixa Notifications Standalone Microservice"
    "org.opencontainers.image.source"      = "https://github.com/Kyvera-Labs/verixa"
  }
}
