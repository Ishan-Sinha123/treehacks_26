FROM docker.elastic.co/elasticsearch/elasticsearch:9.2.0

ENV xpack.security.enabled=false
ENV discovery.type=single-node

EXPOSE 9200 9300

HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD curl -f http://localhost:9200/_cluster/health || exit 1