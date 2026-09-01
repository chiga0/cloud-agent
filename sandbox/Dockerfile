# 沙箱镜像:预装 qwen-code,避免每次 attempt 现场 npm install(冷启动 30s+)。
# 镜像 tag 必须与 @cloudflare/sandbox SDK 同一条 release line,升级时两边一起动。
FROM docker.io/cloudflare/sandbox:0.8.14

ARG QWEN_CODE_VERSION=0.21.10

RUN npm install -g --no-audit --no-fund @qwen-code/qwen-code@${QWEN_CODE_VERSION} \
  && qwen --version
