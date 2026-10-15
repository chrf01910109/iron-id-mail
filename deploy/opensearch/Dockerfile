# IRON ID mail search: OpenSearch for the mail engine's full-text index.
# Deploy as its own Railway service named "opensearch" (see deploy/opensearch/README.md).
FROM opensearchproject/opensearch:2.19.3

USER root
# setpriv (util-linux) to drop root after preparing the volume; openssl for certificates.
# Only the security plugin is kept: removing the rest saves memory and attack surface.
RUN dnf install -y util-linux openssl && dnf clean all && rm -rf /var/cache/dnf \
 && cd /usr/share/opensearch \
 && for p in plugins/*; do [ "$(basename "$p")" = opensearch-security ] || rm -rf "$p"; done \
 && rm -rf bin/opensearch-performance-analyzer

COPY --chown=1000:1000 opensearch.yml /usr/share/opensearch/config/opensearch.yml
COPY security/ /usr/local/ironid-search/security/
COPY templates/ /usr/local/ironid-search/templates/
COPY ironid-entrypoint.sh /usr/local/ironid-search/ironid-entrypoint.sh
RUN chmod 755 /usr/local/ironid-search/ironid-entrypoint.sh

ENV OPENSEARCH_JAVA_OPTS="-Xms512m -Xmx512m"
# Index data and certificates live in /var/lib/ironid-search: attach a Railway volume there
# (Railway does not allow the VOLUME instruction).
EXPOSE 9200

# Starts as root only to fix volume ownership and create certificates, then drops to "opensearch".
ENTRYPOINT ["/usr/local/ironid-search/ironid-entrypoint.sh"]
