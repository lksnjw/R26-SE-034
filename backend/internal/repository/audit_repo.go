package repository

// Audit persistence currently runs on the in-memory Store. Production storage
// should append these records to an immutable PostgreSQL table or event stream.
