# Kubernetes deployment

Build and publish the API image and the `services/extractor` image, replace the image names in the manifests, then configure `ai-nexus-secrets` with managed PostgreSQL, Redis, Anthropic, encryption, and optional embedding credentials.

Apply in order:

```sh
kubectl apply -f namespace.yaml
kubectl apply -f config.yaml
kubectl apply -f migrate.yaml
kubectl wait --for=condition=complete job/database-migrate -n ai-nexus --timeout=180s
kubectl apply -f api.yaml
kubectl apply -f worker.yaml
kubectl apply -f extractor.yaml
```
