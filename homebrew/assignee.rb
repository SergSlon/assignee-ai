# Homebrew formula for assignee CLI
# Tap repository: homebrew-assignee
# Install: brew tap assignee-ai/assignee && brew install assignee
#
# NOTE: This file is a TEMPLATE. The release workflow
# (`.github/workflows/release.yml.disabled`) renders the $VERSION / $SHA_*
# variables via envsubst at publish time and commits the rendered formula to
# the tap repo. Do not hand-edit the rendered copy in the tap — edit this
# template instead.

class Assignee < Formula
  desc "AI-Native Cloud Operator — plan and apply infrastructure with natural language"
  homepage "https://assignee.ai"
  license "MIT"
  version "${VERSION}"

  depends_on "node@22"

  on_macos do
    on_arm do
      url "https://github.com/assignee-ai/assignee/releases/download/${VERSION}/assignee-${VERSION}-darwin-arm64.tar.gz"
      sha256 "${SHA_DARWIN_ARM64}"
    end
    on_intel do
      url "https://github.com/assignee-ai/assignee/releases/download/${VERSION}/assignee-${VERSION}-darwin-x64.tar.gz"
      sha256 "${SHA_DARWIN_X64}"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/assignee-ai/assignee/releases/download/${VERSION}/assignee-${VERSION}-linux-arm64.tar.gz"
      sha256 "${SHA_LINUX_ARM64}"
    end
    on_intel do
      url "https://github.com/assignee-ai/assignee/releases/download/${VERSION}/assignee-${VERSION}-linux-x64.tar.gz"
      sha256 "${SHA_LINUX_X64}"
    end
  end

  def install
    # The release tarball is produced by `pnpm deploy --prod` in the
    # package-binaries job. That means it already contains a self-contained
    # `node_modules/` with @ai-sdk/*, @aws-sdk/*, @langchain/*, etc. —
    # everything the CLI needs at runtime. `Dir["*"]` is a glob against
    # the untarred top-level, so `node_modules/` ships into `libexec`
    # alongside `dist/`, `package.json`, `completions/`, etc.
    #
    # If the tarball ever shrinks back to "dist only", the wrapper below
    # will crash on first `@ai-sdk/*` import. The release workflow's
    # smoke-test job catches that before users ever run brew install —
    # see .github/workflows/release.yml.disabled (L9-B1 / L9-H5).
    libexec.install Dir["*"]

    # Create wrapper that uses the formula's Node
    (bin/"assignee").write <<~SH
      #!/bin/bash
      exec "#{Formula["node@22"].opt_bin}/node" "#{libexec}/dist/index.js" "$@"
    SH

    # Install shell completions
    bash_completion.install "#{libexec}/completions/assignee.bash" => "assignee"
    zsh_completion.install "#{libexec}/completions/assignee.zsh" => "_assignee"
    fish_completion.install "#{libexec}/completions/assignee.fish"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/assignee --version")
  end
end
