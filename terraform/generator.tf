resource "aws_instance" "generator" {
  ami                    = local.ami_id
  instance_type          = var.generator_instance_type
  subnet_id              = aws_subnet.public[0].id
  vpc_security_group_ids = [aws_security_group.generator.id]
  iam_instance_profile   = aws_iam_instance_profile.ec2.arn
  key_name               = var.key_name != "" ? var.key_name : null

  monitoring = true

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 2
  }

  root_block_device {
    volume_type           = "gp2"
    volume_size           = 30
    encrypted             = true
    delete_on_termination = true
  }

  user_data_replace_on_change = true
  user_data_base64 = base64gzip(templatefile("${path.module}/userdata/generator.sh.tftpl", {
    k6_version         = var.k6_version
    git_url            = var.app_source_git_url
    git_ref            = var.app_source_git_ref
    alb_dns            = aws_lb.main.dns_name
    test_id            = var.test_id
    scenarios_js_b64   = filebase64("${path.module}/../load/scenarios.js")
    diagnostics_js_b64 = filebase64("${path.module}/../load/diagnostics.js")
    common_js_b64      = filebase64("${path.module}/../load/lib/common.js")
  }))

  tags = {
    Name = "${local.name}-generator"
    Role = "generator"
  }

  depends_on = [time_sleep.iam_propagation]
}

# Why c6i.xlarge (default):
#   k6 constant-arrival-rate at 1000 RPS is userspace-CPU heavy on the
#   generator. c6i.xlarge is 4 vCPU Ice Lake compute-optimized, 8 GiB,
#   sized so this HTTP mix should not be generator-bound. If CloudWatch
#   CPUUtilization on this instance exceeds ~70% in the steady window,
#   the run is invalid — do not attribute those errors to the topology.
