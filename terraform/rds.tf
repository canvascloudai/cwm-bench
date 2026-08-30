resource "random_password" "db" {
  length  = 24
  special = false
}

resource "aws_ssm_parameter" "db_password" {
  name        = "/cwm-bench/${local.id_slug}/db-password"
  description = "RDS master password for this cwm-bench apply. Not a measurement."
  type        = "SecureString"
  value       = random_password.db.result
}

# Destroy order (AWS eventual consistency — do not invert):
#   1. aws_db_instance.main          (timeouts.delete 60m)
#   2. aws_db_subnet_group.main
#   3. aws_security_group.rds / remaining SGs / VPC
#
# RDS-managed ENIs are AWS-managed. Do not DetachNetworkInterface and do
# not broaden IAM for that call. Wait for RDS deletion to release them,
# then retry destroy (scripts/terraform-destroy-retry.sh).
resource "aws_db_subnet_group" "main" {
  name       = "${local.name}-${local.id_slug}"
  subnet_ids = aws_subnet.private[*].id

  tags = {
    Name = "${local.name}-db-subnets"
  }
}

# mysql8.0 family. max_connections is set explicitly so the campaign
# declares the cap instead of inheriting a drifting engine default.
#
# Cited vs formula (neither is a CloudWatch observation from this repo):
#   - CWM public accuracy page cites ~500 max connections on db.r5.large.
#   - RDS MySQL default formula is {DBInstanceClassMemory/12582880}.
#     On db.r5.large (16 GiB) that is about 1365.
#   - This parameter group defaults to 500 so 2 x APP_POOL_SIZE=250 can
#     present the cited cap. Override with var.mysql_max_connections.
resource "aws_db_parameter_group" "main" {
  name        = "${local.name}-${local.id_slug}"
  family      = "mysql8.0"
  description = "cwm-bench: declared max_connections (default 500)"

  parameter {
    name  = "max_connections"
    value = tostring(var.mysql_max_connections)
  }

  tags = {
    Name = "${local.name}-mysql80"
  }
}

resource "aws_db_instance" "main" {
  identifier = "${local.name}-${local.id_slug}"

  engine               = "mysql"
  engine_version       = var.db_engine_version
  instance_class       = var.db_instance_class
  license_model        = "general-public-license"
  parameter_group_name = aws_db_parameter_group.main.name
  db_subnet_group_name = aws_db_subnet_group.main.name
  vpc_security_group_ids = [
    aws_security_group.rds.id,
  ]

  allocated_storage = var.db_allocated_storage_gb
  storage_type      = "gp2"
  storage_encrypted = true
  # gp2: baseline = allocated_storage * 3 IOPS; burst 3000 IOPS while
  # BurstBalance > 0. Default 100 GiB => 300 baseline, 3000 burst.
  # When BurstBalance hits 0, count iops_throttle — do not fold that
  # into CPU failures or DB connection failures.

  multi_az                   = false
  availability_zone          = local.azs[0]
  publicly_accessible        = false
  backup_retention_period    = 0
  skip_final_snapshot        = true
  deletion_protection        = false
  apply_immediately          = true
  auto_minor_version_upgrade = true
  copy_tags_to_snapshot      = false

  db_name  = "cwmbench"
  username = var.db_username
  password = random_password.db.result
  port     = 3306

  performance_insights_enabled = false

  # skip_final_snapshot / deletion_protection stay as-is so cleanup can
  # destroy. deletion_protection must remain false.
  #
  # Create/update match AWS provider defaults. Delete is explicit so
  # terraform waits for the instance (and its ENI) to finish disappearing
  # before the subnet group / SGs are processed.
  timeouts {
    create = "40m"
    update = "80m"
    delete = "60m"
  }

  # Implicit edges already encode this (db_subnet_group_name,
  # parameter_group_name, vpc_security_group_ids). Listed so destroy
  # order stays: instance first, then subnet group, then SGs / VPC.
  # Addresses are unchanged.
  depends_on = [
    aws_db_subnet_group.main,
    aws_db_parameter_group.main,
    aws_security_group.rds,
  ]

  tags = {
    Name = "${local.name}-mysql"
  }
}
