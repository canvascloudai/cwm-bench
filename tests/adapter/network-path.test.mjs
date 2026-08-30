import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('generator reaches the ALB over a VPC-local security-group path', () => {
  const alb = readFileSync(path.join(ROOT, 'terraform/alb.tf'), 'utf8');
  const security = readFileSync(path.join(ROOT, 'terraform/security.tf'), 'utf8');

  assert.match(alb, /resource "aws_lb" "main"[\s\S]*internal\s*=\s*true/);
  assert.match(alb, /resource "aws_lb" "main"[\s\S]*subnets\s*=\s*aws_subnet\.private\[\*\]\.id/);
  assert.match(
    security,
    /resource "aws_vpc_security_group_ingress_rule" "alb_http_from_generator"[\s\S]*referenced_security_group_id\s*=\s*aws_security_group\.generator\.id/,
  );
  assert.doesNotMatch(alb, /internal\s*=\s*false/);
});