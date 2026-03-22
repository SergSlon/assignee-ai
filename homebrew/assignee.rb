# Homebrew formula for assignee CLI
# Tap repository: homebrew-assignee
# Install: brew tap assignee-ai/assignee && brew install assignee
#
# NOTE: sha256 and url are updated automatically by the release workflow.

class Assignee < Formula
  desc "AI-Native Cloud Operator — plan and apply infrastructure with natural language"
  homepage "https://assignee.ai"
  url "https://github.com/assignee-ai/assignee/releases/download/v0.1.0/assignee-v0.1.0.tar.gz"
  sha256 "PLACEHOLDER_SHA256"
  license "MIT"

  depends_on "node@22"

  def install
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
