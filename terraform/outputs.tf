output "alb_dns" {
  description = "ALB DNS name. k6 TARGET=http://<alb_dns>"
  value       = aws_lb.main.dns_name
}

output "alb_arn" {
  description = "ALB ARN. CloudWatch AWS/ApplicationELB LoadBalancer dimension is the suffix after loadbalancer/."
  value       = aws_lb.main.arn
}

output "target_group_arn" {
  description = "App target group ARN. CloudWatch TargetGroup dimension is the suffix including targetgroup/."
  value       = aws_lb_target_group.app.arn
}

output "rds_endpoint" {
  description = "RDS MySQL endpoint hostname"
  value       = aws_db_instance.main.address
}

output "generator_ip" {
  description = "Public IPv4 of the load-generator instance"
  value       = aws_instance.generator.public_ip
}

output "dashboard_url" {
  description = "CloudWatch dashboard URL (name-based; no account id is stored in this repo)"
  value       = "https://${var.region}.console.aws.amazon.com/cloudwatch/home?region=${var.region}#dashboards:name=${aws_cloudwatch_dashboard.main.dashboard_name}"
}

output "resolved_ami_id" {
  description = "AMI actually used. Copy this into campaign terraform.amiIds. The SSM parameter is not a pin."
  value       = local.ami_id
  sensitive   = true
}

output "ami_source" {
  description = "Whether the AMI came from var.ami_id or the drifting SSM parameter"
  value       = var.ami_id != "" ? "variable" : "ssm-al2023-latest"
}

output "app_instance_ids" {
  description = "App EC2 instance ids (CloudWatch CPUUtilization per node)"
  value       = aws_instance.app[*].id
}

output "app_root_volume_ids" {
  description = "App root EBS volume ids (CloudWatch AWS/EBS BurstBalance)"
  value       = aws_instance.app[*].root_block_device[0].volume_id
}

output "rds_identifier" {
  description = "RDS instance identifier"
  value       = aws_db_instance.main.identifier
}

output "generator_instance_id" {
  description = "Load-generator instance id. Discard a run if this host's CPU exceeds ~70%."
  value       = aws_instance.generator.id
}

output "gp2_notes" {
  description = "Documented gp2 baseline vs burst. Not measured."
  value = {
    app_root_gb            = var.app_root_volume_gb
    app_root_baseline_iops = local.app_root_baseline_iops
    rds_gb                 = var.db_allocated_storage_gb
    rds_baseline_iops      = local.rds_baseline_iops
    burst_iops             = local.gp2_burst_iops
    third_error_bucket     = "BurstBalance=0 is iops_throttle, distinct from CPU and DB connection failures"
  }
}

output "topology_declaration" {
  description = "Canonical topology as applied. Changing any field is a new topology."
  value = {
    region                  = var.region
    alb                     = "application"
    app_count               = var.app_count
    app_instance_type       = var.app_instance_type
    app_pool_size           = var.app_pool_size
    db_instance_class       = var.db_instance_class
    db_engine               = "mysql"
    db_engine_version       = var.db_engine_version
    db_multi_az             = false
    mysql_max_connections   = var.mysql_max_connections
    generator_instance_type = var.generator_instance_type
    test_id                 = var.test_id
  }
}
