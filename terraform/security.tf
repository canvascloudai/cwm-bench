# Paths (only these):
#   generator -> ALB :80 and :443
#   ALB       -> app :8080
#   app       -> RDS :3306
# Optional extra CIDRs may reach the ALB; default is generator-only.

resource "aws_security_group" "alb" {
  name        = "${local.name}-alb"
  description = "ALB: 80/443 from generator (and optional CIDRs)"
  vpc_id      = aws_vpc.main.id

  tags = {
    Name = "${local.name}-alb"
  }
}

resource "aws_security_group" "app" {
  name        = "${local.name}-app"
  description = "App nodes: 8080 from ALB only"
  vpc_id      = aws_vpc.main.id

  tags = {
    Name = "${local.name}-app"
  }
}

resource "aws_security_group" "rds" {
  name        = "${local.name}-rds"
  description = "RDS: 3306 from app nodes only"
  vpc_id      = aws_vpc.main.id

  tags = {
    Name = "${local.name}-rds"
  }
}

resource "aws_security_group" "generator" {
  name        = "${local.name}-generator"
  description = "Load generator: egress to ALB and package mirrors"
  vpc_id      = aws_vpc.main.id

  tags = {
    Name = "${local.name}-generator"
  }
}

resource "aws_vpc_security_group_ingress_rule" "alb_http_from_generator" {
  security_group_id            = aws_security_group.alb.id
  referenced_security_group_id = aws_security_group.generator.id
  ip_protocol                  = "tcp"
  from_port                    = 80
  to_port                      = 80
  description                  = "generator to ALB :80"
}

resource "aws_vpc_security_group_ingress_rule" "alb_https_from_generator" {
  security_group_id            = aws_security_group.alb.id
  referenced_security_group_id = aws_security_group.generator.id
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
  description                  = "generator to ALB :443 (listener only if acm_certificate_arn is set)"
}

resource "aws_vpc_security_group_ingress_rule" "alb_http_from_cidr" {
  count             = length(var.allowed_ingress_cidrs)
  security_group_id = aws_security_group.alb.id
  cidr_ipv4         = var.allowed_ingress_cidrs[count.index]
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
  description       = "optional extra CIDR to ALB :80"
}

resource "aws_vpc_security_group_ingress_rule" "alb_https_from_cidr" {
  count             = length(var.allowed_ingress_cidrs)
  security_group_id = aws_security_group.alb.id
  cidr_ipv4         = var.allowed_ingress_cidrs[count.index]
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  description       = "optional extra CIDR to ALB :443"
}

resource "aws_vpc_security_group_egress_rule" "alb_to_app" {
  security_group_id            = aws_security_group.alb.id
  referenced_security_group_id = aws_security_group.app.id
  ip_protocol                  = "tcp"
  from_port                    = 8080
  to_port                      = 8080
  description                  = "ALB to app :8080"
}

resource "aws_vpc_security_group_ingress_rule" "app_from_alb" {
  security_group_id            = aws_security_group.app.id
  referenced_security_group_id = aws_security_group.alb.id
  ip_protocol                  = "tcp"
  from_port                    = 8080
  to_port                      = 8080
  description                  = "ALB to app :8080"
}

resource "aws_vpc_security_group_egress_rule" "app_to_rds" {
  security_group_id            = aws_security_group.app.id
  referenced_security_group_id = aws_security_group.rds.id
  ip_protocol                  = "tcp"
  from_port                    = 3306
  to_port                      = 3306
  description                  = "app to RDS :3306"
}

resource "aws_vpc_security_group_egress_rule" "app_https_out" {
  security_group_id = aws_security_group.app.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  description       = "package installs (Node 20, git)"
}

resource "aws_vpc_security_group_egress_rule" "app_http_out" {
  security_group_id = aws_security_group.app.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
  description       = "package installs (yum mirrors)"
}

resource "aws_vpc_security_group_ingress_rule" "rds_from_app" {
  security_group_id            = aws_security_group.rds.id
  referenced_security_group_id = aws_security_group.app.id
  ip_protocol                  = "tcp"
  from_port                    = 3306
  to_port                      = 3306
  description                  = "app to RDS :3306"
}

resource "aws_vpc_security_group_egress_rule" "generator_all" {
  security_group_id = aws_security_group.generator.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
  description       = "k6 to ALB plus package installs"
}
