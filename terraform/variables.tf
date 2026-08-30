variable "region" {
  type        = string
  description = "AWS region. Canonical topology is us-east-1. A different region is a holdout, not a silent default change."
  default     = "us-east-1"
}

variable "test_id" {
  type        = string
  description = "Identifier stamped on every resource (tag TestId). Use the campaign_id or a date-stamped slug."
  default     = "cwm-bench-unspecified"
}

variable "extra_tags" {
  type        = map(string)
  description = "Additional resource tags merged into the default set."
  default     = {}
}

variable "name_prefix" {
  type        = string
  description = "Name prefix for resources."
  default     = "cwm-bench"
}

variable "vpc_cidr" {
  type        = string
  description = "VPC CIDR."
  default     = "10.42.0.0/16"
}

variable "app_count" {
  type        = number
  description = "App node count. Canonical topology is 2. Changing this is a new topology."
  default     = 2
}

variable "app_instance_type" {
  type        = string
  description = "App instance type. Canonical topology is m5.large."
  default     = "m5.xlarge"
}

variable "app_root_volume_gb" {
  type        = number
  description = "gp2 root volume size (GiB) for each app node. Baseline IOPS = size * 3; burst to 3000 IOPS while BurstBalance > 0. Default 30 GiB => 90 baseline IOPS."
  default     = 30
}

variable "app_pool_size" {
  type        = number
  description = "APP_POOL_SIZE on each app node (mysql2 connectionLimit). Default 250 so 2 x 250 can present 500 sessions toward the RDS max_connections override."
  default     = 250
}

variable "app_queue_limit" {
  type        = number
  description = "mysql2 queueLimit. Exhaustion is error class queue_full."
  default     = 50
}

variable "generator_instance_type" {
  type        = string
  description = "Load-generator instance type. Default c6i.xlarge: 4 vCPU compute-optimized so k6 can drive 1000 RPS without the generator becoming the bottleneck. If generator CPU exceeds ~70% during a run, discard the run."
  default     = "c6i.xlarge"
}

variable "k6_version" {
  type        = string
  description = "Pinned k6 release tag installed on the generator (linux amd64 tarball)."
  default     = "v0.54.0"
}

variable "db_instance_class" {
  type        = string
  description = "RDS instance class. Canonical topology is db.r5.large."
  default     = "db.r5.large"
}

variable "db_engine_version" {
  type        = string
  description = "RDS MySQL 8.0 major (AWS picks a current 8.0 minor). Record the resolved engine version in campaign metadata after apply."
  default     = "8.0"
}

variable "db_allocated_storage_gb" {
  type        = number
  description = "RDS gp2 storage (GiB). Baseline IOPS = size * 3; burst 3000 IOPS while BurstBalance > 0. Default 100 GiB => 300 baseline IOPS, 3000 burst. BurstBalance=0 is the iops_throttle bucket."
  default     = 100
}

variable "mysql_max_connections" {
  type        = number
  description = "Parameter-group override for max_connections. Default 500 matches the CWM-cited cap and 2 x APP_POOL_SIZE=250. This is a declared topology choice, not a measured default. The RDS MySQL formula DBInstanceClassMemory/12582880 is higher on db.r5.large (~16 GiB => ~1365). We override so the bench can saturate the cited cap. See terraform/README.md."
  default     = 500
}

variable "db_username" {
  type        = string
  description = "RDS master username."
  default     = "cwmbench"
}

variable "ami_id" {
  type        = string
  description = "Optional pinned AMI id. Empty (default) resolves Amazon Linux 2023 via the SSM public parameter at apply time. Record the resolved AMI in campaign metadata. Do not treat the SSM parameter as a frozen id."
  default     = ""
}

variable "key_name" {
  type        = string
  description = "Optional EC2 key pair. Empty relies on SSM Session Manager."
  default     = ""
}

variable "acm_certificate_arn" {
  type        = string
  description = "Optional ACM certificate ARN. When set, ALB also listens on 443. Default measurement uses HTTP:80 because this repo does not ship a certificate."
  default     = ""
}

variable "allowed_ingress_cidrs" {
  type        = list(string)
  description = "Extra CIDRs allowed to the ALB on 80/443 in addition to the generator security group. Empty keeps the ALB generator-only."
  default     = []
}

variable "app_source_git_url" {
  type        = string
  description = "Exact git URL the app and generator user_data fetch. Required at boot. There is no fallback to a different repository."
  default     = "https://github.com/canvascloudai/cwm-bench.git"

  validation {
    condition     = var.app_source_git_url != ""
    error_message = "app_source_git_url must be the campaign repository URL. user_data will not fall back to another URL."
  }
}

variable "app_source_git_ref" {
  type        = string
  description = "Exact commit SHA the app and generator user_data check out. Empty or a branch name (main/master/HEAD) fails user_data loudly. Set this to the campaign's measurement SHA."
  default     = ""

  validation {
    condition     = var.app_source_git_ref == "" || can(regex("^[0-9a-fA-F]{7,40}$", var.app_source_git_ref))
    error_message = "app_source_git_ref must be a git commit SHA (7-40 hex chars). Branch names including main, master, and HEAD are rejected."
  }
}
