# Bridgectl Quick Command Reference

| Action | Command |
|---|---|
| Check context | `bridgectl context list` |
| Refresh docs | `bridgectl doc` |
| Register API | `bridgectl api register --name ... --url ... --method ... --module ... --description ... --auth-type ... --auth-key ...` |
| Test API | `bridgectl api test <name>` |
| Generate schema | `bridgectl tool generate --api <name> -o yaml > <name>.yaml` (writes a YAML sequence for OpenAPI input) |
| Apply tool | `bridgectl tool apply -f <name>.yaml` (applies every sequence item or YAML document) |
| List tools | `bridgectl tool get` |
| Describe tool | `bridgectl tool describe <name>` |
