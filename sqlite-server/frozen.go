package main

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
)

// FrozenStore holds day-partitioned frozen data: a per-day SQLite file (`spans.sqlite`, the raw
// spans for that day) + a small `rollups.json` snapshot (so overviews survive restart without
// downloading the big file). Two backends behind one interface: local dir, or S3/MinIO.
type FrozenStore interface {
	PutDayFile(day, localPath string) error   // store the day's SQLite file
	PutRollups(day string, data []byte) error // store the small rollups snapshot
	GetRollups(day string) ([]byte, error)    // fetch the rollups snapshot
	EnsureLocal(day string) (string, error)   // local path to the day's SQLite file (download if s3)
	ListDays() ([]string, error)
	Drop(day string) error
}

var dayRe = regexp.MustCompile(`day=([0-9]{4}-[0-9]{2}-[0-9]{2})`)

// ---- local backend ----

type localFrozen struct{ base string }

func (l *localFrozen) dir(day string) string { return filepath.Join(l.base, "day="+day) }

func (l *localFrozen) PutDayFile(day, localPath string) error {
	if err := os.MkdirAll(l.dir(day), 0o755); err != nil {
		return err
	}
	return moveOrCopy(localPath, filepath.Join(l.dir(day), "spans.sqlite"))
}
func (l *localFrozen) PutRollups(day string, data []byte) error {
	if err := os.MkdirAll(l.dir(day), 0o755); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(l.dir(day), "rollups.json"), data, 0o644)
}
func (l *localFrozen) GetRollups(day string) ([]byte, error) {
	return os.ReadFile(filepath.Join(l.dir(day), "rollups.json"))
}
func (l *localFrozen) EnsureLocal(day string) (string, error) {
	p := filepath.Join(l.dir(day), "spans.sqlite")
	if _, err := os.Stat(p); err != nil {
		return "", err
	}
	return p, nil
}
func (l *localFrozen) ListDays() ([]string, error) {
	entries, err := os.ReadDir(l.base)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	var days []string
	for _, e := range entries {
		if m := dayRe.FindStringSubmatch(e.Name()); m != nil {
			if _, err := os.Stat(filepath.Join(l.base, e.Name(), "spans.sqlite")); err == nil {
				days = append(days, m[1])
			}
		}
	}
	return days, nil
}
func (l *localFrozen) Drop(day string) error { return os.RemoveAll(l.dir(day)) }

// ---- s3 backend (MinIO / S3) ----

type s3Frozen struct {
	client   *minio.Client
	bucket   string
	cacheDir string
}

func newS3Frozen(cfg S3Config, cacheDir string) (*s3Frozen, error) {
	host := strings.TrimPrefix(strings.TrimPrefix(cfg.Endpoint, "http://"), "https://")
	secure := strings.HasPrefix(cfg.Endpoint, "https")
	opts := &minio.Options{
		Creds:  credentials.NewStaticV4(cfg.AccessKey, cfg.SecretKey, ""),
		Secure: secure,
		Region: cfg.Region,
	}
	if cfg.URLStyle == "path" {
		opts.BucketLookup = minio.BucketLookupPath
	}
	client, err := minio.New(host, opts)
	if err != nil {
		return nil, err
	}
	ctx := context.Background()
	exists, err := client.BucketExists(ctx, cfg.Bucket)
	if err != nil {
		return nil, fmt.Errorf("s3 bucket check (%s): %w", host, err)
	}
	if !exists {
		if err := client.MakeBucket(ctx, cfg.Bucket, minio.MakeBucketOptions{Region: cfg.Region}); err != nil {
			return nil, err
		}
	}
	if err := os.MkdirAll(cacheDir, 0o755); err != nil {
		return nil, err
	}
	return &s3Frozen{client: client, bucket: cfg.Bucket, cacheDir: cacheDir}, nil
}

func (s *s3Frozen) key(day, name string) string { return fmt.Sprintf("day=%s/%s", day, name) }

func (s *s3Frozen) PutDayFile(day, localPath string) error {
	_, err := s.client.FPutObject(context.Background(), s.bucket, s.key(day, "spans.sqlite"), localPath, minio.PutObjectOptions{ContentType: "application/x-sqlite3"})
	return err
}
func (s *s3Frozen) PutRollups(day string, data []byte) error {
	_, err := s.client.PutObject(context.Background(), s.bucket, s.key(day, "rollups.json"), bytes.NewReader(data), int64(len(data)), minio.PutObjectOptions{ContentType: "application/json"})
	return err
}
func (s *s3Frozen) GetRollups(day string) ([]byte, error) {
	obj, err := s.client.GetObject(context.Background(), s.bucket, s.key(day, "rollups.json"), minio.GetObjectOptions{})
	if err != nil {
		return nil, err
	}
	defer obj.Close()
	return io.ReadAll(obj)
}
func (s *s3Frozen) EnsureLocal(day string) (string, error) {
	p := filepath.Join(s.cacheDir, "day="+day+".sqlite")
	if _, err := os.Stat(p); err == nil {
		return p, nil
	}
	if err := s.client.FGetObject(context.Background(), s.bucket, s.key(day, "spans.sqlite"), p, minio.GetObjectOptions{}); err != nil {
		return "", err
	}
	return p, nil
}
func (s *s3Frozen) ListDays() ([]string, error) {
	seen := map[string]bool{}
	var days []string
	for obj := range s.client.ListObjects(context.Background(), s.bucket, minio.ListObjectsOptions{Prefix: "day=", Recursive: true}) {
		if obj.Err != nil {
			return nil, obj.Err
		}
		if m := dayRe.FindStringSubmatch(obj.Key); m != nil && strings.HasSuffix(obj.Key, "spans.sqlite") && !seen[m[1]] {
			seen[m[1]] = true
			days = append(days, m[1])
		}
	}
	return days, nil
}
func (s *s3Frozen) Drop(day string) error {
	ctx := context.Background()
	s.client.RemoveObject(ctx, s.bucket, s.key(day, "spans.sqlite"), minio.RemoveObjectOptions{})
	s.client.RemoveObject(ctx, s.bucket, s.key(day, "rollups.json"), minio.RemoveObjectOptions{})
	os.Remove(filepath.Join(s.cacheDir, "day="+day+".sqlite"))
	return nil
}

func newFrozenStore(cfg Config) (FrozenStore, error) {
	if cfg.ColdKind == "s3" {
		return newS3Frozen(cfg.S3, filepath.Join(cfg.DataDir, "cold-cache"))
	}
	base := filepath.Join(cfg.DataDir, "cold")
	os.MkdirAll(base, 0o755)
	return &localFrozen{base: base}, nil
}

func moveOrCopy(src, dst string) error {
	if err := os.Rename(src, dst); err == nil {
		return nil
	}
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	if err := out.Close(); err != nil {
		return err
	}
	os.Remove(src)
	return nil
}
