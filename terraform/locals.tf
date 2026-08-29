data "aws_availability_zones" "available" {
  state = "available"
}

# Amazon Linux 2023 x86_64, current kernel, via the public SSM parameter.
# This value DRIFTS. terraform apply records whatever AMI the parameter
# points at that day. Pin var.ami_id for a campaign, and always write the
# resolved AMI id into the run's terraform.amiIds field.
data "aws_ssm_parameter" "al2023" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64"
}

locals {
  id_slug = lower(replace(var.test_id, "_", "-"))

  azs = slice(data.aws_availability_zones.available.names, 0, 2)

  ami_id = var.ami_id != "" ? var.ami_id : data.aws_ssm_parameter.al2023.value

  name = var.name_prefix

  public_cidrs  = [cidrsubnet(var.vpc_cidr, 8, 0), cidrsubnet(var.vpc_cidr, 8, 1)]
  private_cidrs = [cidrsubnet(var.vpc_cidr, 8, 10), cidrsubnet(var.vpc_cidr, 8, 11)]

  common_tags = merge(
    {
      Project   = "cwm-bench"
      TestId    = var.test_id
      ManagedBy = "terraform"
      Topology  = "alb-2x-m5.large-db.r5.large-mysql80-single-az"
    },
    var.extra_tags,
  )

  # Documented gp2 burst behavior (AWS EBS gp2):
  #   burst IOPS = 3000 for volumes <= 1 TiB
  #   baseline IOPS = volume_giB * 3
  #   BurstBalance is percent of burst credits remaining (0..100)
  #   BurstBalance = 0 => IOPS capped at baseline = iops_throttle bucket
  app_root_baseline_iops = var.app_root_volume_gb * 3
  rds_baseline_iops      = var.db_allocated_storage_gb * 3
  gp2_burst_iops         = 3000
}
