# 沙箱镜像:预装 qwen-code,避免每次 attempt 现场 npm install(冷启动 30s+)。
# 镜像 tag 必须与 @cloudflare/sandbox SDK 同一条 release line,升级时两边一起动。
FROM docker.io/cloudflare/sandbox:0.8.14

ARG QWEN_CODE_VERSION=0.21.10

# 镜像内 npm 带有阿里内网源(registry.anpm.alibaba-inc.com),出站 allowlist 只放行
# registry.npmjs.org,沙箱内 npm ci 会全部 520。ENV 是 npm 配置的最高优先级,
# 可覆盖 user/global 级 .npmrc;再显式重置各级配置并打印验证。
ENV npm_config_registry=https://registry.npmjs.org

RUN npm config set registry https://registry.npmjs.org --location=global \
  && (npm config delete registry --location=user || true) \
  && npm install -g --no-audit --no-fund @qwen-code/qwen-code@${QWEN_CODE_VERSION} \
  && npm config get registry \
  && qwen --version
